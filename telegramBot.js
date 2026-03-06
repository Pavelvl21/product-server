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

// ==================== ЦВЕТНОЕ ЛОГИРОВАНИЕ ====================
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function logCommand(userId, command, status = 'start', details = '') {
  const timestamp = new Date().toLocaleTimeString();
  const statusColor = {
    start: colors.blue,
    success: colors.green,
    error: colors.red,
    warning: colors.yellow
  }[status] || colors.reset;
  
  const statusIcon = {
    start: '▶️',
    success: '✅',
    error: '❌',
    warning: '⚠️'
  }[status] || '•';
  
  console.log(
    `${colors.dim}[${timestamp}]${colors.reset} ` +
    `${statusColor}${statusIcon}${colors.reset} ` +
    `${colors.bright}[${command}]${colors.reset} ` +
    `${colors.cyan}userId:${userId}${colors.reset} ` +
    `${details}`
  );
}

function logRateLimit(userId, command, waitTime) {
  console.log(
    `${colors.yellow}⏳ RateLimit${colors.reset} ` +
    `${colors.dim}[${command}]${colors.reset} ` +
    `${colors.cyan}userId:${userId}${colors.reset} ` +
    `${colors.yellow}жди ${waitTime}с${colors.reset}`
  );
}

function logAPI(endpoint, status, time, details = '') {
  const statusColor = status === 'success' ? colors.green : colors.red;
  console.log(
    `${colors.magenta}🌐 API${colors.reset} ` +
    `${statusColor}[${status}]${colors.reset} ` +
    `${colors.dim}${endpoint}${colors.reset} ` +
    `${colors.yellow}${time}ms${colors.reset} ` +
    `${details}`
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
      console.log(`${colors.red}❌ Telegram API error:${colors.reset} ${result.description}`);
    }
    
    return result;
  } catch (err) {
    console.error(`${colors.red}❌ Telegram send error:${colors.reset}`, err);
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
    '/changes': 5000,
    '/goods': 3000,
    '/status': 2000,
    'default': 1000
  };
  
  const limit = limits[command] || limits.default;
  
  if (now - lastTime < limit) {
    const waitTime = Math.ceil((limit - (now - lastTime)) / 1000);
    logRateLimit(userId, command, waitTime);
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
    logCommand(telegramId, 'lock', 'success', `выбор заблокирован`);
  } catch (err) {
    console.error('Ошибка блокировки выбора:', err);
  }
}

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ ====================

async function getCategoriesFromServer() {
  const startTime = Date.now();
  try {
    const response = await fetch(`${API_URL}/api/public/categories`);
    const time = Date.now() - startTime;
    
    if (!response.ok) {
      logAPI('/api/public/categories', 'error', time, `status:${response.status}`);
      return [];
    }
    
    const data = await response.json();
    logAPI('/api/public/categories', 'success', time, `категорий:${data.categories?.length || 0}`);
    return data.categories || [];
  } catch (err) {
    logAPI('/api/public/categories', 'error', Date.now() - startTime, err.message);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================

async function getProductsFromServer() {
  const startTime = Date.now();
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 10000
    });
    const time = Date.now() - startTime;
    
    if (!response.ok) {
      logAPI('/api/bot/products', 'error', time, `status:${response.status}`);
      return null;
    }
    
    const data = await response.json();
    logAPI('/api/bot/products', 'success', time, `товаров:${data.products?.length || 0}`);
    return data;
  } catch (err) {
    logAPI('/api/bot/products', 'error', Date.now() - startTime, err.message);
    return null;
  }
}

async function getPriceChanges() {
  const data = await getProductsFromServer();
  if (!data?.products) {
    console.log('❌ [getPriceChanges] Нет данных от API');
    return [];
  }
  
  const changes = data.products
    .filter(p => p.priceToday && p.priceYesterday && Math.abs(p.priceToday - p.priceYesterday) > 0.01)
    .map(p => {
      // Логируем полученные из API данные
      console.log(`📊 [getPriceChanges] Товар ${p.code}:`, {
        name: p.name,
        base_price: p.base_price,
        packPrice: p.packPrice,
        priceToday: p.priceToday
      });
      
      return {
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
      };
    });

  console.log(`📊 [getPriceChanges] Найдено изменений: ${changes.length} (⬆️ ${changes.filter(c => !c.isDecrease).length} / ⬇️ ${changes.filter(c => c.isDecrease).length})`);
  
  // Сортируем
  changes.sort((a, b) => {
    if (!a.isDecrease && !b.isDecrease) return b.change - a.change;
    if (a.isDecrease && b.isDecrease) return a.change - b.change;
    return a.isDecrease ? 1 : -1;
  });

  return changes;
}

async function getProductsByCategory(categories) {
  logCommand(0, 'getProductsByCategory', 'start', `категории:${categories.length}`);
  const data = await getProductsFromServer();
  
  if (!data?.products) {
    logCommand(0, 'getProductsByCategory', 'error', 'нет данных от API');
    return [];
  }
  
  const products = data.products.filter(p => categories.includes(p.category));
  logCommand(0, 'getProductsByCategory', 'success', `найдено товаров:${products.length}`);
  return products;
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
  
  // Логируем входящие данные для отладки
  console.log('🛠️ [formatProductFull] Входные данные:', {
    code: product.product_code,
    name: product.product_name,
    base_price: product.base_price,
    packPrice: product.packPrice,
    previous_price: product.previous_price,
    current_price: product.current_price
  });
  
  // Для РЦ в рассрочку используем base_price (полная стоимость)
  const retailPrice = product.base_price || product.packPrice || null;
  
  console.log(`   💳 Итоговая цена рассрочки: ${retailPrice} (${retailPrice ? 'есть' : 'НЕТ'})`);
  
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
  console.log('🔔 [formatPriceChangeNotification] Создание уведомления для товара:', {
    code: product.code,
    name: product.name,
    basePrice: product.basePrice,
    packPrice: product.packPrice
  });
  
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
  logCommand(userId, 'showCategoryList', 'start', 'запрос категорий');
  
  const categories = await getCategoriesFromServer();
  if (!categories.length) {
    logCommand(userId, 'showCategoryList', 'error', 'категории недоступны');
    await sendMessage(chatId, '📭 Категории временно недоступны');
    return;
  }

  logCommand(userId, 'showCategoryList', 'success', `получено категорий:${categories.length}`);
  
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
  
  logCommand(userId, 'showCategoryList', 'success', 'категории показаны');
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
  
  logCommand(ADMIN_CHAT_ID, 'newUser', 'success', `новый пользователь:${userId}`);
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  logCommand(userId, text, 'start');

  const user = await getUser(userId);

  // === СКРЫТАЯ КОМАНДА ДЛЯ ПРОВЕРКИ АДМИНСТВА ===
  if (text === '/isAdmin') {
    const isAdmin = (userId == ADMIN_CHAT_ID);
    await sendMessage(chatId, isAdmin ? '✅ Да' : '❌ Нет');
    logCommand(userId, '/isAdmin', 'success', isAdmin ? 'админ' : 'не админ');
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
      logCommand(userId, '/help_broadcast', 'success');
      return;
    }

    if (text.startsWith('/broadcast ')) {
      const messageText = text.replace('/broadcast ', '');
      logCommand(userId, '/broadcast', 'start', `длина:${messageText.length}`);
      
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
        logCommand(userId, '/broadcast', 'success', `успешно:${results.success}, ошибок:${results.failed}`);
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
        logCommand(userId, '/broadcast_cat', 'error', 'неверный формат');
        return;
      }
      
      const categories = match[1].split(',').map(c => c.trim());
      const messageText = match[2];
      
      logCommand(userId, '/broadcast_cat', 'start', `категории:${categories.length}, текст:${messageText.length} символов`);
      
      await sendMessage(chatId, `📣 Рассылка по категориям: ${categories.join(', ')}`);
      
      broadcastToCategories(messageText, categories).then(results => {
        sendMessage(ADMIN_CHAT_ID, formatBroadcastResults(results, 'categories'));
        logCommand(userId, '/broadcast_cat', 'success', `успешно:${results.success}, ошибок:${results.failed}`);
      });
      
      return;
    }

    if (text.startsWith('/test_broadcast ')) {
      const messageText = text.replace('/test_broadcast ', '');
      logCommand(userId, '/test_broadcast', 'start', `текст:${messageText}`);
      
      const sent = await sendTestMessage(messageText);
      await sendMessage(chatId, sent ? '✅ Тест отправлен' : '❌ Ошибка');
      
      logCommand(userId, '/test_broadcast', sent ? 'success' : 'error');
      return;
    }

    if (text === '/stats') {
      logCommand(userId, '/stats', 'start', 'запрос статистики');
      
      const stats = await getSubscriberStats();
      await sendMessage(chatId, formatSubscriberStats(stats));
      
      logCommand(userId, '/stats', 'success', `всего:${stats.total}, категорий:${Object.keys(stats.byCategory).length}`);
      return;
    }
  }

  // === ОБРАБОТКА /START ===
  if (text === '/start') {
    if (!user) {
      logCommand(userId, '/start', 'start', 'новый пользователь');
      await saveUser(userId, username, firstName, lastName, chatId);
      await notifyAdminAboutNewUser(userId, username, firstName, chatId);
      await sendMessage(chatId, '⏳ Запрос отправлен администратору. Ожидайте.');
      logCommand(userId, '/start', 'success', 'отправлен на модерацию');
      return;
    }

    if (user.status === 'approved') {
      logCommand(userId, '/start', 'start', `одобрен, выбор_заблокирован:${user.selection_locked}`);
      
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
      logCommand(userId, '/start', 'success', 'приветствие отправлено');
    } else {
      await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается');
      logCommand(userId, '/start', 'warning', `статус:${user.status}`);
    }
    return;
  }

  // === ПРОВЕРКА СТАТУСА ===
  if (!user || user.status !== 'approved') {
    logCommand(userId, text, 'error', `доступ запрещён, статус:${user?.status || 'не найден'}`);
    await sendMessage(chatId, '❌ Доступ запрещён');
    return;
  }

  // === /STATUS ===
  if (text === '/status') {
    logCommand(userId, '/status', 'start');
    
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
    
    logCommand(userId, '/status', 'success', `категорий:${categories.length}, заблокирован:${user.selection_locked}`);
    return;
  }

  // === /GOODS ===
  if (text === '/goods') {
    logCommand(userId, '/goods', 'start');
    
    if (!checkRateLimit(userId, '/goods')) return;

    const categories = user.selected_categories || [];
    if (!categories.length) {
      logCommand(userId, '/goods', 'error', 'нет категорий');
      await sendMessage(chatId, '❌ Категории не выбраны');
      return;
    }

    const products = await getProductsByCategory(categories);
    if (!products.length) {
      logCommand(userId, '/goods', 'warning', 'нет товаров');
      await sendMessage(chatId, '📭 Нет товаров');
      return;
    }

    logCommand(userId, '/goods', 'success', `найдено товаров:${products.length}`);
    await sendMessage(chatId, `📦 Найдено товаров: ${products.length}. Отправляю список...`);

    const batchSize = 50;
    let sentCount = 0;
    
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const list = batch.map(p => `• ${p.name}`).join('\n');
      const header = `📋 Часть ${Math.floor(i/batchSize) + 1}/${Math.ceil(products.length/batchSize)}:\n\n`;
      
      await sendMessage(chatId, header + list);
      sentCount += batch.length;
      
      logCommand(userId, '/goods', 'success', `отправлена часть ${Math.floor(i/batchSize) + 1}: ${batch.length} товаров`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    logCommand(userId, '/goods', 'success', `всего отправлено:${sentCount} товаров`);
    return;
  }

  // === /CHANGES ===
  if (text === '/changes') {
    logCommand(userId, '/changes', 'start');
    
    if (!checkRateLimit(userId, '/changes')) return;

    const categories = user.selected_categories || [];
    if (!categories.length) {
      logCommand(userId, '/changes', 'error', 'нет категорий');
      await sendMessage(chatId, '❌ Категории не выбраны');
      return;
    }

    const allChanges = await getPriceChanges();
    const changes = allChanges.filter(c => categories.includes(c.category));

    if (!changes.length) {
      logCommand(userId, '/changes', 'warning', 'нет изменений');
      await sendMessage(chatId, '📭 Сегодня нет изменений в выбранных категориях');
      return;
    }

    logCommand(userId, '/changes', 'success', `найдено изменений:${changes.length}`);
    await sendMessage(chatId, `📊 Найдено изменений: ${changes.length}`);

    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      await sendMessage(chatId, formatProductFull(ch));
      
      if (i < changes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if ((i + 1) % 10 === 0) {
        logCommand(userId, '/changes', 'success', `отправлено ${i + 1}/${changes.length}`);
      }
    }
    
    logCommand(userId, '/changes', 'success', `все ${changes.length} изменений отправлены`);
    return;
  }

  // === /HELP ===
  if (text === '/help') {
    logCommand(userId, '/help', 'start');
    
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
    logCommand(userId, '/help', 'success');
    return;
  }

  // === НЕИЗВЕСТНАЯ КОМАНДА ===
  logCommand(userId, text, 'warning', 'неизвестная команда');
  await sendMessage(chatId, '❓ Неизвестная команда. /help');
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  console.log(`${colors.magenta}📞 Callback:${colors.reset} ${data} ${colors.cyan}from:${fromId}${colors.reset}`);

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
    console.log(`${colors.green}✅ Категория добавлена:${colors.reset} ${category} для ${fromId}`);
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
    console.log(`${colors.green}✅ Выбор завершён для ${fromId}, категорий:${selected.length}${colors.reset}`);
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

    console.log(`${colors.green}✅ Подтверждаю пользователя ${userId}${colors.reset}`);
    
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
      console.log(`${colors.red}❌ Пользователь ${userId} отклонён${colors.reset}`);
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
      console.log(`${colors.red}🚫 Пользователь ${userId} заблокирован${colors.reset}`);
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
    console.error(`${colors.red}❌ Update error:${colors.reset}`, err);
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

export { notifyPriceChange };
