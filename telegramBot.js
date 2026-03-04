import fetch from 'node-fetch';
import db from './database.js';
import {
  broadcastToAll,
  broadcastToCategories,
  getSubscriberStats,
  formatBroadcastResults,
  formatSubscriberStats,
  sendTestMessage,
  notifyPriceChange
} from './telegramBroadcast.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Хранилище для rate limiting
const userLastCommand = new Map();

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
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
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
    console.error('Callback answer error:', err);
  }
}

function checkRateLimit(userId, command) {
  const key = `${userId}_${command}`;
  const now = Date.now();
  const lastTime = userLastCommand.get(key) || 0;
  
  const limits = {
    '/changes': 10000,
    '/goods': 5000,
    '/status': 2000,
    'default': 1000
  };
  
  const limit = limits[command] || limits.default;
  if (now - lastTime < limit) return false;
  
  userLastCommand.set(key, now);
  if (userLastCommand.size > 1000) {
    const oldKeys = [...userLastCommand.keys()].filter(k => now - userLastCommand.get(k) > 60000);
    oldKeys.forEach(k => userLastCommand.delete(k));
  }
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
    console.error('Ошибка в getUser:', err);
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
    console.error('Ошибка сохранения пользователя:', err);
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
    console.error('Ошибка обновления статуса:', err);
  }
}

async function updateUserCategories(telegramId, categories) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
  } catch (err) {
    console.error('Ошибка обновления категорий:', err);
  }
}

async function lockUserSelection(telegramId) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selection_locked = ? WHERE telegram_id = ?',
      args: [true, telegramId]
    });
    console.log(`🔒 Выбор заблокирован для ${telegramId}`);
  } catch (err) {
    console.error('Ошибка блокировки выбора:', err);
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
    console.error('Ошибка получения категорий:', err);
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
    console.error('Ошибка получения данных:', err);
    return null;
  }
}

async function getPriceChanges() {
  const data = await getProductsFromServer();
  if (!data?.products) return [];
  
  return data.products
    .filter(p => p.priceToday && p.priceYesterday && Math.abs(p.priceToday - p.priceYesterday) > 0.01)
    .map(p => ({
      product_code: p.code,
      product_name: p.name,
      current_price: p.priceToday,
      previous_price: p.priceYesterday,
      change: p.priceToday - p.priceYesterday,
      percent: ((p.priceToday - p.priceYesterday) / p.priceYesterday * 100).toFixed(1),
      packPrice: p.packPrice,
      monthly_payment: p.monthly_payment,
      no_overpayment_max_months: p.no_overpayment_max_months,
      link: p.link,
      category: p.category,
      brand: p.brand,
      isDecrease: p.priceToday < p.priceYesterday
    }));
}

async function getProductsByCategory(categories) {
  const data = await getProductsFromServer();
  if (!data?.products) return [];
  return data.products.filter(p => categories.includes(p.category));
}

// ==================== ФОРМАТИРОВАНИЕ ====================

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  const formatted = Math.abs(price).toFixed(2).replace('.', ',');
  if (price > 0) return `+${formatted}`;
  if (price < 0) return `-${formatted}`;
  return formatted;
}

export function formatProductFull(product) {
  const circleEmoji = product.isDecrease ? '🔴' : '🟢';
  
  const installmentPrice = product.packPrice ? product.packPrice.toFixed(2).replace('.', ',') : '—';
  
  return `
${circleEmoji} <b>${product.product_name}</b>
📋 Код: <code>${product.product_code}</code>
💰 <b>Было:</b> ${formatPrice(product.previous_price)} руб.
💰 <b>Стало:</b> ${formatPrice(product.current_price)} руб. ${circleEmoji} ${formatPrice(product.change)} (${product.percent}%)
💳 РЦ в рассрочку: ${installmentPrice} руб.
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
}

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
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
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  console.log(`📨 ${text} от ${userId}`);
  // 🔍 ДОБАВЬТЕ ЭТО
  console.log(`🔍 Проверка пользователя ${userId}: ищем в БД...`);
  
  const user = await getUser(userId);
  
  console.log(`🔍 Результат getUser:`, user ? 'найден' : 'НЕ НАЙДЕН');
  if (user) {
    console.log(`🔍 Статус: ${user.status}, категорий: ${user.selected_categories?.length || 0}`);
  }
  // === КОМАНДЫ АДМИНА (доступны всегда) ===
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

  // === ОБЫЧНЫЕ КОМАНДЫ ===
  if (text === '/status') {
    if (!checkRateLimit(userId, '/status')) return;
    
    const locked = user.selection_locked ? '🔒 Заблокирован' : '🔓 Можно выбрать';
    const categories = user.selected_categories || [];
    const catText = categories.length 
      ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
      : '\n📁 Категории не выбраны';
    
    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🔒 Выбор категорий: ${locked}${catText}`
    );
    return;
  }

  if (text === '/goods') {
  console.log('='.repeat(50));
  console.log(`🔍 [GOODS] Начало обработки команды /goods от пользователя ${userId}`);
  console.log(`🔍 [GOODS] Время: ${new Date().toISOString()}`);
  
  // Проверка rate limit
  console.log(`🔍 [GOODS] Проверка rate limit для ${userId}...`);
  if (!checkRateLimit(userId, '/goods')) {
    console.log(`❌ [GOODS] Rate limit сработал для ${userId}`);
    await sendMessage(chatId, '⏳ Слишком частые запросы. Подождите несколько секунд.');
    return;
  }
  console.log(`✅ [GOODS] Rate limit пройден`);

  // Проверка пользователя
  console.log(`🔍 [GOODS] Проверка пользователя ${userId}...`);
  const user = await getUser(userId);
  console.log(`🔍 [GOODS] Результат getUser:`, user ? 'найден' : 'НЕ НАЙДЕН');
  
  if (!user) {
    console.log(`❌ [GOODS] Пользователь ${userId} не найден в БД`);
    await sendMessage(chatId, '❌ Пользователь не найден. Используйте /start');
    return;
  }
  
  console.log(`🔍 [GOODS] Статус пользователя: ${user.status}`);
  if (user.status !== 'approved') {
    console.log(`❌ [GOODS] Пользователь ${userId} не подтвержден (статус: ${user.status})`);
    await sendMessage(chatId, '❌ Ваш аккаунт не подтвержден');
    return;
  }

  // Проверка категорий
  console.log(`🔍 [GOODS] Категории пользователя:`, user.selected_categories || []);
  const categories = user.selected_categories || [];
  
  if (!categories.length) {
    console.log(`❌ [GOODS] У пользователя ${userId} нет выбранных категорий`);
    await sendMessage(chatId, '❌ Категории не выбраны. Используйте /start для выбора категорий');
    return;
  }
  console.log(`✅ [GOODS] Категории найдены: ${categories.length} шт.`);

  // Получение данных с API
  console.log(`🔍 [GOODS] Запрос к API /api/bot/products...`);
  const startTime = Date.now();
  
  try {
    const data = await getProductsFromServer();
    const apiTime = Date.now() - startTime;
    console.log(`🔍 [GOODS] API ответил за ${apiTime}мс`);
    
    if (!data) {
      console.log(`❌ [GOODS] API вернул null или undefined`);
      await sendMessage(chatId, '❌ Ошибка получения данных с сервера');
      return;
    }
    
    console.log(`🔍 [GOODS] API ответ:`, {
      hasProducts: !!data.products,
      productsCount: data.products?.length || 0,
      today: data.today,
      yesterday: data.yesterday
    });
    
    if (!data.products || !Array.isArray(data.products)) {
      console.log(`❌ [GOODS] data.products отсутствует или не массив`);
      await sendMessage(chatId, '❌ Ошибка формата данных с сервера');
      return;
    }

    // Фильтрация товаров по категориям
    console.log(`🔍 [GOODS] Фильтрация товаров по категориям:`, categories);
    const products = data.products.filter(p => categories.includes(p.category));
    
    console.log(`🔍 [GOODS] Результаты фильтрации:`, {
      всего_товаров: data.products.length,
      подходящих: products.length,
      категории_в_товарах: [...new Set(data.products.map(p => p.category))],
      категории_пользователя: categories
    });

    if (products.length === 0) {
      console.log(`❌ [GOODS] Нет товаров в выбранных категориях`);
      
      // Проверим, есть ли вообще товары с такими категориями
      const availableCategories = [...new Set(data.products.map(p => p.category))];
      const missingCategories = categories.filter(c => !availableCategories.includes(c));
      
      if (missingCategories.length > 0) {
        console.log(`❌ [GOODS] Следующие категории не найдены в товарах:`, missingCategories);
        await sendMessage(chatId, 
          `📭 Нет товаров в выбранных категориях.\n\n` +
          `⚠️ Следующие категории пусты:\n${missingCategories.map(c => `• ${c}`).join('\n')}`
        );
      } else {
        await sendMessage(chatId, '📭 В выбранных категориях нет товаров');
      }
      return;
    }

    console.log(`✅ [GOODS] Найдено товаров: ${products.length}`);

    // Проверка длины сообщения
    const productNames = products.map(p => `• ${p.name}`).join('\n');
    const header = `📦 Товаров: ${products.length}\n\n`;
    const fullMessage = header + productNames;
    
    console.log(`📏 [GOODS] Длина сообщения: ${fullMessage.length} символов`);
    
    if (fullMessage.length > 4000) {
      console.log(`⚠️ [GOODS] Сообщение слишком длинное (${fullMessage.length} > 4000), отправляем частями`);
      
      await sendMessage(chatId, `📦 Найдено товаров: ${products.length}. Отправляю список частями...`);
      
      // Разбиваем на части по 50 товаров
      const batchSize = 50;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        const batchNames = batch.map(p => `• ${p.name}`).join('\n');
        const batchHeader = `📋 Часть ${Math.floor(i/batchSize) + 1}/${Math.ceil(products.length/batchSize)} (${i+1}-${Math.min(i+batchSize, products.length)}):\n\n`;
        const batchMessage = batchHeader + batchNames;
        
        console.log(`📏 [GOODS] Часть ${Math.floor(i/batchSize) + 1}: ${batchMessage.length} символов`);
        await sendMessage(chatId, batchMessage);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      console.log(`✅ [GOODS] Все части отправлены`);
    } else {
      console.log(`✅ [GOODS] Отправка полного сообщения...`);
      await sendMessage(chatId, fullMessage);
    }

    console.log(`✅ [GOODS] Команда /goods успешно выполнена для ${userId}`);
    
  } catch (error) {
    console.error(`❌ [GOODS] Ошибка при выполнении команды:`, error);
    await sendMessage(chatId, '❌ Произошла ошибка при получении списка товаров');
  }
  
  console.log('='.repeat(50));
  return;
}

  if (text === '/changes') {
    if (!checkRateLimit(userId, '/changes')) return;
    
    const categories = user.selected_categories || [];
    if (!categories.length) {
      await sendMessage(chatId, '❌ Категории не выбраны');
      return;
    }

    const allChanges = await getPriceChanges();
    const changes = allChanges.filter(c => categories.includes(c.category));

    if (!changes.length) {
      await sendMessage(chatId, '📭 Сегодня нет изменений в выбранных категориях');
      return;
    }

    await sendMessage(chatId, `📊 Найдено изменений: ${changes.length}`);

    for (const ch of changes) {
      await sendMessage(chatId, formatProductFull(ch));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return;
  }

  if (text === '/help') {
    const commands = [
      '📋 <b>Доступные команды:</b>',
      '',
      '👤 <b>Для всех:</b>',
      '/help - это сообщение',
      '/start - начало работы',
      '/status - статус и категории',
      '/changes - изменения цен за сегодня',
      '/goods - список товаров',
      '',
      'ℹ️ Категории выбираются один раз при регистрации.'
    ];
    
    await sendMessage(chatId, commands.join('\n'));
    return;
  }

  await sendMessage(chatId, '❓ Неизвестная команда. /help');
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  console.log('📞 Callback:', data);

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

    console.log(`✅ Подтверждаю пользователя ${userId}, chat_id: ${targetUser.chat_id}`);
    
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

    const sent = await sendMessage(targetUser.chat_id, 
      '✅ <b>Ваш запрос одобрен!</b>\n\n' +
      'Теперь выберите категории товаров для отслеживания:'
    );
    
    console.log(`📤 Сообщение отправлено:`, sent ? 'ok' : 'fail');
    
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
}

// ==================== ЭКСПОРТЫ ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('❌ Update error:', err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    const users = await db.execute(`
      SELECT telegram_id, username, first_name, last_name, status, selected_categories,
             requested_at, approved_at, approved_by, selection_locked
      FROM telegram_users
      ORDER BY requested_at DESC
    `);
    res.json(users.rows);
  });
}

export async function sendTelegramMessage(message) {
  return await sendMessage(ADMIN_CHAT_ID, message);
}
