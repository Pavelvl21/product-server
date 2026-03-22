import fetch from 'node-fetch';
import db from './database.js';
import {
  broadcastToAll,
  broadcastToCategories,
  getSubscriberStats,
  formatBroadcastResults,
  formatSubscriberStats,
  sendTestMessage,
} from './telegramBroadcast.js';
import { config } from './src/config/env.js';

// Затем замените:
const BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = config.TELEGRAM_CHAT_ID;
const SECRET_KEY = config.SECRET_KEY;
const API_URL = config.API_URL || 'http://localhost:3000';

// Хранилище для rate limiting
const userLastCommand = new Map();

// ==================== ЛОГИРОВАНИЕ (только ошибки) ====================
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m'
};

function logError(context, error, details = '') {
  console.error(
    `${colors.red}❌ Ошибка${colors.reset} ` +
    `[${context}] ${error.message} ${details}`
  );
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

async function sendMessage(chatId, text, options = {}) {
  if (!BOT_TOKEN) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      })
    });
    const result = await res.json();
    
    if (!result.ok) {
      console.error(`${colors.red}❌ Telegram API error:${colors.reset} ${result.description}`);
    }
    
    return result;
  } catch (err) {
    logError('sendMessage', err, `chatId:${chatId}`);
    return false;
  }
}

async function answerCallback(callbackId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: text,
        show_alert: false
      })
    });
  } catch (err) {
    logError('answerCallback', err);
  }
}

function checkRateLimit(userId, command) {
  const key = `${userId}_${command}`;
  const now = Date.now();
  const lastTime = userLastCommand.get(key) || 0;
  
  const limits = {
    '/changes': 5000,
    '/goods': 3000,
    '/status': 2000,
    'default': 1000
  };
  
  const limit = limits[command] || limits.default;
  
  if (now - lastTime < limit) {
    return false;
  }
  
  userLastCommand.set(key, now);
  
  // Очистка старых записей
  const oldKeys = [...userLastCommand.keys()].filter(k => now - userLastCommand.get(k) > 60000);
  oldKeys.forEach(k => userLastCommand.delete(k));
  
  return true;
}

// ==================== РАБОТА С БД ====================

async function getUser(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories, selection_locked FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
      } catch {
        user.selected_categories = [];
      }
      return user;
    }
    return null;
  } catch (err) {
    logError('getUser', err, `telegramId:${telegramId}`);
    return null;
  }
}

async function saveUser(telegramId, username, firstName, lastName, chatId) {
  try {
    await db.execute({
      sql: `INSERT INTO telegram_users 
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories, selection_locked)
            VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?)`,
      args: [telegramId, username || '', firstName || '', lastName || '', chatId, false]
    });
  } catch (err) {
    logError('saveUser', err, `telegramId:${telegramId}`);
  }
}

async function updateUserStatus(telegramId, status, approvedBy = null) {
  try {
    const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL';
    await db.execute({
      sql: `UPDATE telegram_users 
            SET status = ?, 
                approved_at = ${approvedAt},
                approved_by = ?
            WHERE telegram_id = ?`,
      args: [status, approvedBy, telegramId]
    });
  } catch (err) {
    logError('updateUserStatus', err, `telegramId:${telegramId}`);
  }
}

async function updateUserCategories(telegramId, categories) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
  } catch (err) {
    logError('updateUserCategories', err, `telegramId:${telegramId}`);
  }
}

async function lockUserSelection(telegramId) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selection_locked = ? WHERE telegram_id = ?',
      args: [true, telegramId]
    });
  } catch (err) {
    logError('lockUserSelection', err, `telegramId:${telegramId}`);
  }
}

// ==================== НОВАЯ ФУНКЦИЯ ДЛЯ ПОЛУЧЕНИЯ ТОВАРОВ ИЗ МОНИТОРИНГА ====================
async function getUserMonitoringProducts(telegramId) {
  try {
    // 1. Сначала ищем пользователя в таблице telegram_users
    const telegramUser = await db.execute({
      sql: 'SELECT user_id FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (telegramUser.rows.length === 0) {
      console.log(`❌ Пользователь ${telegramId} не найден в telegram_users`);
      return [];
    }
    
    const userId = telegramUser.rows[0].user_id;
    
    if (!userId) {
      console.log(`⚠️ У пользователя ${telegramId} нет привязки к users (user_id = null)`);
      return [];
    }
    
    // 2. Получаем товары из мониторинга
    const monitoringResult = await db.execute({
      sql: 'SELECT product_code FROM user_shelf WHERE user_id = ?',
      args: [userId]
    });
    
    console.log(`📦 Найдено товаров в мониторинге: ${monitoringResult.rows.length}`);
    
    return monitoringResult.rows.map(row => row.product_code);
    
  } catch (err) {
    logError('getUserMonitoringProducts', err, `telegramId:${telegramId}`);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ ====================

async function getCategoriesFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/public/categories`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.categories || [];
  } catch (err) {
    logError('getCategoriesFromServer', err);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================

async function getProductsFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 10000
    });
    
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    logError('getProductsFromServer', err);
    return null;
  }
}

async function getPriceChanges() {
  try {
    const data = await getProductsFromServer();
    if (!data?.products) return [];
    
    const changes = data.products
      .filter(p => p.priceToday && p.priceYesterday && Math.abs(p.priceToday - p.priceYesterday) > 0.01)
      .map(p => ({
        product_code: p.code,
        product_name: p.name,
        current_price: p.priceToday,
        previous_price: p.priceYesterday,
        change: p.priceToday - p.priceYesterday,
        percent: ((p.priceToday - p.priceYesterday) / p.priceYesterday * 100).toFixed(1),
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        link: p.link,
        category: p.category,
        brand: p.brand,
        isDecrease: p.priceToday < p.priceYesterday
      }));

    // Сортируем
    changes.sort((a, b) => {
      if (!a.isDecrease && !b.isDecrease) return b.change - a.change;
      if (a.isDecrease && b.isDecrease) return a.change - b.change;
      return a.isDecrease ? 1 : -1;
    });

    return changes;
  } catch (err) {
    logError('getPriceChanges', err);
    return [];
  }
}

async function getProductsByCategory(categories) {
  try {
    const data = await getProductsFromServer();
    if (!data?.products) return [];
    return data.products.filter(p => categories.includes(p.category));
  } catch (err) {
    logError('getProductsByCategory', err);
    return [];
  }
}

// ==================== ФОРМАТИРОВАНИЕ ====================

function formatPrice(price, options = {}) {
  if (price === null || price === undefined) return '—';
  
  const num = typeof price === 'string' ? parseFloat(price) : Number(price);
  if (isNaN(num)) return '—';
  
  const formatted = num.toFixed(2).replace('.', ',');
  
  const { withSign = false } = options;
  
  if (!withSign) return formatted;
  
  if (num > 0) return `+${formatted}`;
  if (num < 0) return `-${formatted}`;
  return formatted;
}

export function formatProductFull(product) {
  const circleEmoji = product.isDecrease ? '🔴' : '🟢';
  const retailPrice = product.base_price || product.packPrice || null;
  
  return `
${circleEmoji} ${product.product_name}
📋 Код: ${product.product_code}
💰 Было: ${formatPrice(product.previous_price)} руб.
💰 Стало: ${formatPrice(product.current_price)} руб. ${circleEmoji} ${formatPrice(product.change, { withSign: true })} (${product.percent}%)
💳 РЦ в рассрочку: ${formatPrice(retailPrice)} руб.
⏱ Срок: ${product.no_overpayment_max_months || '—'} мес.
🔗 <a href="https://www.21vek.by${product.link}">Ссылка</a>
`;
}

export function formatPriceChangeNotification(product, oldPrice, newPrice) {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const isDecrease = change < 0;
  
  return formatProductFull({
    product_code: product.code,
    product_name: product.name,
    current_price: newPrice,
    previous_price: oldPrice,
    change: change,
    percent: percent,
    base_price: product.basePrice || product.price,
    packPrice: product.packPrice,
    monthly_payment: product.monthly_payment,
    no_overpayment_max_months: product.no_overpayment_max_months,
    link: product.link,
    category: product.category,
    isDecrease: isDecrease
  });
}

// ==================== ПОКАЗ КАТЕГОРИЙ ====================

async function showCategoryList(chatId, userId) {
  try {
    const categories = await getCategoriesFromServer();
    if (!categories.length) {
      await sendMessage(chatId, '📭 Категории временно недоступны');
      return;
    }

    await sendMessage(chatId, 
      '📋 <b>Доступные категории</b>\n\n' +
      'Нажимайте на кнопки под каждой категорией, чтобы добавить её в свой список.\n' +
      'После выбора всех нужных категорий нажмите "✅ Завершить выбор".'
    );

    for (const category of categories) {
      const keyboard = {
        inline_keyboard: [[
          { text: '➕ Добавить', callback_data: `add_cat_${userId}_${category}` }
        ]]
      };
      
      await sendMessage(chatId, 
        `📌 <b>${category}</b>`,
        { reply_markup: keyboard, parse_mode: 'HTML' }
      );
      
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const finishKeyboard = {
      inline_keyboard: [[
        { text: '✅ Завершить выбор', callback_data: `finish_selection_${userId}` }
      ]]
    };
    
    await sendMessage(chatId, 
      '✅ Когда выберете все нужные категории, нажмите кнопку ниже:',
      { reply_markup: finishKeyboard }
    );
  } catch (err) {
    logError('showCategoryList', err);
    await sendMessage(chatId, '❌ Произошла ошибка при загрузке категорий');
  }
}

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  try {
    const info = [
      `🆔 ID: <code>${userId}</code>`,
      `👤 Имя: ${firstName || '—'}`,
      `📱 Username: ${username ? '@' + username : '—'}`,
      `💬 Chat ID: <code>${chatId}</code>`
    ].join('\n');

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Разрешить', callback_data: `approve_${userId}` },
        { text: '❌ Отклонить', callback_data: `reject_${userId}` },
        { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
      ]]
    };

    await sendMessage(ADMIN_CHAT_ID, `🔔 Новый пользователь!\n\n${info}`, {
      reply_markup: keyboard
    });
  } catch (err) {
    logError('notifyAdminAboutNewUser', err);
  }
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  try {
    const user = await getUser(userId);

    // === СКРЫТАЯ КОМАНДА ДЛЯ ПРОВЕРКИ АДМИНСТВА ===
    if (text === '/isAdmin') {
      const isAdmin = (userId == ADMIN_CHAT_ID);
      await sendMessage(chatId, isAdmin ? '✅ Да' : '❌ Нет');
      return;
    }

    // === КОМАНДЫ АДМИНА ===
    if (userId == ADMIN_CHAT_ID) {
      
      if (text === '/help_broadcast') {
        await sendMessage(chatId,
          '📢 <b>Команды для рассылки</b>\n\n' +
          '<b>/broadcast текст</b> - отправить всем\n' +
          '<b>/broadcast_cat кат1,кат2 текст</b> - по категориям\n' +
          '<b>/test_broadcast текст</b> - тест (только админу)\n' +
          '<b>/stats</b> - статистика подписчиков\n' +
          '<b>/help_broadcast</b> - это сообщение\n\n' +
          '📌 <i>Задержка 35мс между сообщениями</i>'
        );
        return;
      }

      if (text.startsWith('/broadcast ')) {
        const messageText = text.replace('/broadcast ', '');
        await sendMessage(chatId, `📣 Запускаю рассылку всем...`);
        
        broadcastToAll(messageText, {}, (progress) => {
          if (progress.percent % 10 === 0 && progress.current < progress.total) {
            sendMessage(ADMIN_CHAT_ID, 
              `📊 <b>Прогресс:</b> ${progress.percent}%\n` +
              `✅ ${progress.success} | ❌ ${progress.failed}`
            );
          }
        }).then(results => {
          sendMessage(ADMIN_CHAT_ID, formatBroadcastResults(results, 'all'));
        });
        return;
      }

      if (text.startsWith('/broadcast_cat ')) {
        const match = text.match(/\/broadcast_cat\s+([^\s]+(?:\s*,\s*[^\s]+)*)\s+(.+)/);
        
        if (!match) {
          await sendMessage(chatId, 
            '❌ <b>Неверный формат</b>\n\n' +
            'Используйте: /broadcast_cat категория1,категория2 Текст\n' +
            'Пример: /broadcast_cat Электроника,Ноутбуки Скидка 20%!'
          );
          return;
        }
        
        const categories = match[1].split(',').map(c => c.trim());
        const messageText = match[2];
        
        await sendMessage(chatId, `📣 Рассылка по категориям: ${categories.join(', ')}`);
        
        broadcastToCategories(messageText, categories).then(results => {
          sendMessage(ADMIN_CHAT_ID, formatBroadcastResults(results, 'categories'));
        });
        return;
      }

      if (text.startsWith('/test_broadcast ')) {
        const messageText = text.replace('/test_broadcast ', '');
        const sent = await sendTestMessage(messageText);
        await sendMessage(chatId, sent ? '✅ Тест отправлен' : '❌ Ошибка');
        return;
      }

      if (text === '/stats') {
        const stats = await getSubscriberStats();
        await sendMessage(chatId, formatSubscriberStats(stats));
        return;
      }
    }

    // === ОБРАБОТКА /START ===
    if (text === '/start') {
      if (!user) {
        await saveUser(userId, username, firstName, lastName, chatId);
        await notifyAdminAboutNewUser(userId, username, firstName, chatId);
        await sendMessage(chatId, '⏳ Запрос отправлен администратору. Ожидайте.');
        return;
      }

      if (user.status === 'approved') {
        if (!user.selection_locked) {
          await showCategoryList(chatId, userId);
        } else {
          await sendMessage(chatId, 
            '👋 Добро пожаловать!\n\n' +
            '📋 <b>Команды:</b>\n' +
            '/goods - список товаров\n' +
            '/changes - изменения цен\n' +
            '/status - статус\n' +
            '/help - помощь'
          );
        }
      } else {
        await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается');
      }
      return;
    }

    // === ПРОВЕРКА СТАТУСА ===
    if (!user || user.status !== 'approved') {
      await sendMessage(chatId, '❌ Доступ запрещён');
      return;
    }

    // === /STATUS ===
    if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) return;
      
      const locked = user.selection_locked ? 'заблокирован' : 'можно выбрать';
      const categories = user.selected_categories || [];
      const catText = categories.length 
        ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
        : '\n📁 Категории не выбраны';
      
      await sendMessage(chatId,
        `✅ Статус: подтверждён\n` +
        `🔒 Выбор категорий: ${locked}${catText}`
      );
      return;
    }

    // === /GOODS ===
    if (text === '/goods') {
      if (!checkRateLimit(userId, '/goods')) return;

      const monitoringCodes = await getUserMonitoringProducts(userId);
      
      if (monitoringCodes.length === 0) {
        await sendMessage(chatId, '📭 У вас нет товаров в мониторинге');
        return;
      }

      const data = await getProductsFromServer();
      if (!data?.products) {
        await sendMessage(chatId, '❌ Не удалось получить список товаров');
        return;
      }

      const monitoringProducts = data.products.filter(p => monitoringCodes.includes(p.code));

      if (!monitoringProducts.length) {
        await sendMessage(chatId, '📭 В вашем мониторинге нет товаров');
        return;
      }

      await sendMessage(chatId, `📦 В вашем мониторинге: ${monitoringProducts.length} товаров. Отправляю список...`);

      const batchSize = 50;
      
      for (let i = 0; i < monitoringProducts.length; i += batchSize) {
        const batch = monitoringProducts.slice(i, i + batchSize);
        const list = batch.map(p => `• ${p.name}`).join('\n');
        const header = `📋 Часть ${Math.floor(i/batchSize) + 1}/${Math.ceil(monitoringProducts.length/batchSize)}:\n\n`;
        
        await sendMessage(chatId, header + list);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return;
    }

    // === /CHANGES ===
    if (text === '/changes') {
      if (!checkRateLimit(userId, '/changes')) return;

      const monitoringCodes = await getUserMonitoringProducts(userId);
      
      if (monitoringCodes.length === 0) {
        await sendMessage(chatId, '📭 У вас нет товаров в мониторинге');
        return;
      }

      const allChanges = await getPriceChanges();
      const changes = allChanges.filter(c => monitoringCodes.includes(c.product_code));

      if (!changes.length) {
        await sendMessage(chatId, '📭 Сегодня нет изменений по вашим товарам');
        return;
      }

      await sendMessage(chatId, `📊 Найдено изменений в мониторинге: ${changes.length}`);

      for (let i = 0; i < changes.length; i++) {
        await sendMessage(chatId, formatProductFull(changes[i]));
        
        if (i < changes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      return;
    }

    // === /HELP ===
    if (text === '/help') {
      const commands = [
        '📋 <b>Доступные команды:</b>',
        '',
        '👤 <b>Для всех:</b>',
        '/help - это сообщение',
        '/start - начало работы',
        '/status - статус и категории',
        '/changes - изменения цен за сегодня (только по вашему мониторингу)',
        '/goods - список товаров по категориям',
        '',
        'ℹ️ Категории выбираются один раз при регистрации.'
      ];
      
      await sendMessage(chatId, commands.join('\n'));
      return;
    }

    await sendMessage(chatId, '❓ Неизвестная команда. /help');
    
  } catch (err) {
    logError('handleMessage', err, `userId:${userId}, command:${text}`);
    await sendMessage(chatId, '❌ Произошла внутренняя ошибка');
  }
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  try {
    // === ДОБАВЛЕНИЕ КАТЕГОРИИ ===
    if (data.startsWith('add_cat_')) {
      const parts = data.split('_');
      const userId = parseInt(parts[2]);
      const category = parts.slice(3).join('_');

      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser || currentUser.selection_locked) {
        await answerCallback(query.id, '❌ Выбор уже завершён');
        return;
      }

      const selected = currentUser.selected_categories || [];
      
      if (selected.includes(category)) {
        await answerCallback(query.id, '⚠️ Уже выбрано');
        return;
      }

      const updated = [...selected, category];
      await updateUserCategories(fromId, updated);

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Добавлено', callback_data: 'noop' }
            ]]
          }
        })
      });

      await answerCallback(query.id, `✅ ${category} добавлена`);
      return;
    }

    // === ЗАВЕРШЕНИЕ ВЫБОРА ===
    if (data.startsWith('finish_selection_')) {
      const userId = parseInt(data.replace('finish_selection_', ''));
      
      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser || currentUser.selection_locked) {
        await answerCallback(query.id, '❌ Выбор уже завершён');
        return;
      }

      const selected = currentUser.selected_categories || [];
      if (selected.length === 0) {
        await answerCallback(query.id, '⚠️ Выберите хотя бы одну категорию');
        return;
      }

      await lockUserSelection(fromId);
      
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });

      await sendMessage(msg.chat.id, 
        '✅ <b>Выбор завершён!</b>\n\n' +
        selected.map(c => `• ${c}`).join('\n') + `\n\n` +
        'Теперь вам доступны команды:\n' +
        '/goods - список товаров\n' +
        '/changes - изменения цен'
      );

      await answerCallback(query.id, '✅ Выбор завершён');
      return;
    }

    // === АДМИНСКИЕ КНОПКИ ===
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    if (data.startsWith('approve_')) {
      const userId = data.replace('approve_', '');
      const targetUser = await getUser(userId);
      
      if (!targetUser) {
        await answerCallback(query.id, '❌ Пользователь не найден');
        return;
      }

      await updateUserStatus(userId, 'approved', 'admin');
      
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });

      await sendMessage(targetUser.chat_id, 
        '✅ <b>Ваш запрос одобрен!</b>\n\n' +
        'Теперь выберите категории товаров для отслеживания:'
      );
      
      await showCategoryList(targetUser.chat_id, userId);
      await answerCallback(query.id, '✅ Подтверждено');
      return;
    }

    if (data.startsWith('reject_')) {
      const userId = data.replace('reject_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'rejected', 'admin');
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        });

        await sendMessage(ADMIN_CHAT_ID, `❌ Пользователь ${userId} отклонён`);
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '⛔ <b>Доступ отклонён</b>');
        }
        await answerCallback(query.id, '❌ Отклонено');
      }
      return;
    }

    if (data.startsWith('block_')) {
      const userId = data.replace('block_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'blocked', 'admin');
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        });

        await sendMessage(ADMIN_CHAT_ID, `🚫 Пользователь ${userId} заблокирован`);
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '🚫 <b>Вы заблокированы</b>');
        }
        await answerCallback(query.id, '🚫 Заблокировано');
      }
      return;
    }

    if (data === 'noop') {
      await answerCallback(query.id, '✅');
      return;
    }

    await answerCallback(query.id, '❓ Неизвестная команда');
    
  } catch (err) {
    logError('handleCallback', err, `data:${data}, fromId:${fromId}`);
    await answerCallback(query.id, '❌ Произошла ошибка');
  }
}

// ==================== ЭКСПОРТЫ ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error(`${colors.red}❌ Критическая ошибка в обработчике обновлений:${colors.reset}`, err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    try {
      const users = await db.execute(`
        SELECT telegram_id, username, first_name, last_name, status, selected_categories,
               requested_at, approved_at, approved_by, selection_locked
        FROM telegram_users
        ORDER BY requested_at DESC
      `);
      res.json(users.rows);
    } catch (err) {
      logError('setupBotEndpoints', err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });
}

export async function sendTelegramMessage(message) {
  return await sendMessage(ADMIN_CHAT_ID, message);
}

