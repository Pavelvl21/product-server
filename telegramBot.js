import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Хранилище для rate limiting в боте
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

// Rate limiting для команд бота
function checkRateLimit(userId, command) {
  const key = `${userId}_${command}`;
  const now = Date.now();
  const lastTime = userLastCommand.get(key) || 0;
  
  const limits = {
    '/changes': 10000,
    '/goods': 5000,
    '/list': 2000,
    '/status': 2000,
    'default': 1000
  };
  
  const limit = limits[command] || limits.default;
  
  if (now - lastTime < limit) {
    return false;
  }
  
  userLastCommand.set(key, now);
  
  if (userLastCommand.size > 1000) {
    const oldKeys = [...userLastCommand.keys()]
      .filter(k => now - userLastCommand.get(k) > 60000);
    oldKeys.forEach(k => userLastCommand.delete(k));
  }
  
  return true;
}

// ==================== РАБОТА С БД ПОЛЬЗОВАТЕЛЕЙ ====================

async function getUser(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories, username, first_name FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        if (user.selected_categories) {
          user.selected_categories = JSON.parse(user.selected_categories);
        } else {
          user.selected_categories = [];
        }
      } catch (e) {
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
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      args: [telegramId, username || '', firstName || '', lastName || '', chatId, '[]']
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

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ С СЕРВЕРА ====================
async function getAllCategories() {
  try {
    const response = await fetch(`${API_URL}/api/public/categories`, {
      timeout: 5000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data.categories || [];
  } catch (err) {
    console.error('Ошибка получения категорий с сервера:', err);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ С СЕРВЕРА ====================

async function getProductsFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: {
        'x-bot-key': SECRET_KEY
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (err) {
    console.error('Ошибка получения данных с сервера:', err);
    return null;
  }
}

// ==================== ФУНКЦИЯ ДЛЯ ПОЛУЧЕНИЯ ИЗМЕНЕНИЙ ====================

async function getPriceChanges() {
  const data = await getProductsFromServer();
  
  if (!data || !data.products) {
    return [];
  }
  
  const changes = data.products
    .filter(p => p.priceToday && p.priceYesterday && 
                Math.abs(p.priceToday - p.priceYesterday) > 0.01)
    .map(p => {
      const change = p.priceToday - p.priceYesterday;
      return {
        product_code: p.code,
        product_name: p.name,
        current_price: p.priceToday,
        previous_price: p.priceYesterday,
        change: change,
        percent: (change / p.priceYesterday * 100).toFixed(1),
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        link: p.link,
        category: p.category,
        brand: p.brand,
        isDecrease: change < 0
      };
    })
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  
  return changes;
}

// ==================== ФУНКЦИИ ДЛЯ КАТЕГОРИЙ ====================

async function getProductsByCategory(category) {
  const data = await getProductsFromServer();
  if (!data || !data.products) return [];
  
  return data.products
    .filter(p => p.category === category)
    .map(p => ({
      code: p.code,
      name: p.name,
      last_price: p.priceToday || p.packPrice,
      packPrice: p.packPrice,
      monthly_payment: p.monthly_payment,
      no_overpayment_max_months: p.no_overpayment_max_months,
      link: p.link
    }));
}

// ==================== ВЫБОР КАТЕГОРИЙ ПРИ СТАРТЕ ====================
async function showCategorySelection(chatId, userId) {
  try {
    const categories = await getAllCategories();
    
    if (!categories || categories.length === 0) {
      await sendMessage(chatId, '📭 В базе пока нет категорий. Обратитесь к администратору.');
      return;
    }

    const user = await getUser(userId);
    const selectedCategories = user?.selected_categories || [];

    const buttons = [];
    let row = [];
    
    categories.forEach((cat, index) => {
      const isSelected = selectedCategories.includes(cat);
      const prefix = isSelected ? '✅ ' : '';
      
      row.push({
        text: `${prefix}${cat}`,
        callback_data: `select_cat_${index}_${cat}`
      });
      
      if (row.length === 2) {
        buttons.push([...row]);
        row = [];
      }
    });
    
    if (row.length > 0) {
      buttons.push(row);
    }

    buttons.push([{
      text: '✅ Готово',
      callback_data: 'submit_categories'
    }]);

    const selectedText = selectedCategories.length > 0 
      ? `\n\n<b>Выбрано:</b>\n${selectedCategories.map(c => `✅ ${c}`).join('\n')}` 
      : '';

    await sendMessage(chatId, 
      `📁 <b>Выберите категории для отслеживания</b>\n` +
      `Нажмите на категорию, чтобы выбрать/убрать её. После выбора нажмите "Готово".` +
      selectedText, 
      { 
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    console.error('Ошибка в showCategorySelection:', err);
    await sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
  }
}

// ==================== ФУНКЦИИ ПОКАЗА КАТЕГОРИЙ (ТОЛЬКО LIST) ====================

async function showActiveCategories(chatId, user) {
  try {
    const selectedCategories = user?.selected_categories || [];
    
    if (selectedCategories.length === 0) {
      await sendMessage(chatId, 
        '📭 У вас нет выбранных категорий.\n' +
        'Обратитесь к администратору для изменения списка.'
      );
      return;
    }

    const buttons = [];
    
    selectedCategories.forEach((cat, index) => {
      buttons.push([{
        text: `❌ ${cat}`,
        callback_data: `remove_${index}_${cat}`
      }]);
    });

    buttons.push([{
      text: '🔙 Назад',
      callback_data: 'back_to_main'
    }]);

    await sendMessage(chatId, 
      `📋 <b>Ваши категории (${selectedCategories.length})</b>\n` +
      `Нажмите на категорию чтобы удалить её.\n` +
      `Для добавления новых категорий обратитесь к администратору.`, 
      { 
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    console.error('Ошибка в showActiveCategories:', err);
    await sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
  }
}

// ==================== ФУНКЦИИ ФОРМАТИРОВАНИЯ ====================

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  
  const formatted = Math.abs(price).toFixed(2).replace('.', ',');
  
  if (price > 0) {
    return `+${formatted}`;
  } else if (price < 0) {
    return `-${formatted}`;
  } else {
    return formatted;
  }
}

function formatProductSimple(product) {
  return `• ${product.name}`;
}

function formatProductFull(product) {
  const circleEmoji = product.isDecrease ? '🔴' : '🟢';
  const changeValue = product.change;
  
  return `
${circleEmoji} <b>${product.product_name}</b>
📋 Код: <code>${product.product_code}</code>
💰 <b>Было:</b> ${formatPrice(product.previous_price)} руб.
💰 <b>Стало:</b> ${formatPrice(product.current_price)} руб. ${circleEmoji} ${formatPrice(changeValue)} (${product.percent}%)
💳 РЦ в рассрочку: ${formatPrice(product.packPrice)} руб.
⏱ Срок: ${product.no_overpayment_max_months || '—'} мес.
🔗 <a href="https://www.21vek.by${product.link}">Ссылка на товар</a>
`;
}

// ==================== ФУНКЦИЯ ДЛЯ РАЗБИВКИ ДЛИННЫХ СООБЩЕНИЙ ====================

async function sendLongMessage(chatId, text, options = {}) {
  const MAX_LENGTH = 4096;
  
  if (text.length <= MAX_LENGTH) {
    return await sendMessage(chatId, text, options);
  }
  
  const parts = [];
  let remainingText = text;
  
  while (remainingText.length > 0) {
    let part = remainingText.slice(0, MAX_LENGTH);
    
    const lastNewline = part.lastIndexOf('\n');
    if (lastNewline > 0 && remainingText.length > MAX_LENGTH) {
      part = remainingText.slice(0, lastNewline);
      remainingText = remainingText.slice(lastNewline);
    } else {
      remainingText = remainingText.slice(MAX_LENGTH);
    }
    
    parts.push(part);
  }
  
  for (let i = 0; i < parts.length; i++) {
    const partText = i === 0 
      ? parts[i] 
      : `📌 <b>Продолжение (часть ${i + 1}/${parts.length}):</b>\n\n${parts[i]}`;
    
    await sendMessage(chatId, partText, options);
    
    if (i < parts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return true;
}

// ==================== УВЕДОМЛЕНИЕ АДМИНА ====================
async function notifyAdminAboutNewUser(userId, username, firstName, chatId, selectedCategories) {
  const categoriesList = selectedCategories.map(c => `• ${c}`).join('\n');
  
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `📁 <b>Запрошенные категории (${selectedCategories.length}):</b>\n${categoriesList}`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  // Кнопки для удаления каждой категории
  const categoryButtons = selectedCategories.map(cat => ([{
    text: `❌ Убрать ${cat}`,
    callback_data: `admin_remove_${userId}_${cat}`
  }]));

  // Кнопки для добавления всех доступных категорий
  const allCategories = await getAllCategories();
  const addButtons = [];
  let row = [];
  
  allCategories.forEach((cat, index) => {
    if (!selectedCategories.includes(cat)) {
      row.push({
        text: `➕ ${cat}`,
        callback_data: `admin_add_${userId}_${cat}`
      });
      
      if (row.length === 2) {
        addButtons.push([...row]);
        row = [];
      }
    }
  });
  
  if (row.length > 0) {
    addButtons.push(row);
  }

  const keyboard = {
    inline_keyboard: [
      ...categoryButtons,
      ...addButtons,
      [{ text: '✅ Подтвердить', callback_data: `admin_approve_${userId}` }],
      [{ text: '❌ Отклонить', callback_data: `admin_reject_${userId}` }],
      [{ text: '🚫 Заблокировать', callback_data: `admin_block_${userId}` }]
    ]
  };

  await sendMessage(ADMIN_CHAT_ID, `🔔 <b>Новый запрос на доступ!</b>\n\n${info}`, {
    reply_markup: keyboard
  });
}

// ==================== ОБНОВЛЕНИЕ СООБЩЕНИЯ АДМИНА ====================
async function updateAdminRequestMessage(message, userId) {
  const user = await getUser(userId);
  const selected = user?.selected_categories || [];
  
  const categoriesList = selected.map(c => `• ${c}`).join('\n');
  
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${user.first_name || 'не указано'}`,
    `📱 Username: ${user.username ? '@' + user.username : 'не указан'}`,
    `📁 <b>Выбранные категории (${selected.length}):</b>\n${categoriesList}`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  const categoryButtons = selected.map(cat => ([{
    text: `❌ Убрать ${cat}`,
    callback_data: `admin_remove_${userId}_${cat}`
  }]));

  const allCategories = await getAllCategories();
  const addButtons = [];
  let row = [];
  
  allCategories.forEach((cat, index) => {
    if (!selected.includes(cat)) {
      row.push({
        text: `➕ ${cat}`,
        callback_data: `admin_add_${userId}_${cat}`
      });
      
      if (row.length === 2) {
        addButtons.push([...row]);
        row = [];
      }
    }
  });
  
  if (row.length > 0) {
    addButtons.push(row);
  }

  const keyboard = {
    inline_keyboard: [
      ...categoryButtons,
      ...addButtons,
      [{ text: '✅ Подтвердить', callback_data: `admin_approve_${userId}` }],
      [{ text: '❌ Отклонить', callback_data: `admin_reject_${userId}` }],
      [{ text: '🚫 Заблокировать', callback_data: `admin_block_${userId}` }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `🔔 <b>Запрос на доступ (обновлено)</b>\n\n${info}`,
      parse_mode: 'HTML',
      reply_markup: keyboard
    })
  });
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  try {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text;
    const username = message.from.username;
    const firstName = message.from.first_name;
    const lastName = message.from.last_name;

    console.log(`📨 Обработка команды: ${text} от ${userId}`);

    const user = await getUser(userId);

    if (text === '/start') {
      if (!user) {
        await saveUser(userId, username, firstName, lastName, chatId);
        await showCategorySelection(chatId, userId);
      } else if (user.status === 'approved') {
        await sendMessage(chatId, 
          '👋 С возвращением!\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/list - показать выбранные категории\n' +
          '/goods - показать список товаров\n' +
          '/changes - изменения цен за сегодня\n' +
          '/status - проверить статус\n' +
          '/help - список всех команд'
        );
      } else if (user.status === 'pending') {
        const categories = user.selected_categories || [];
        if (categories.length === 0) {
          await showCategorySelection(chatId, userId);
        } else {
          await sendMessage(chatId, '⏳ Запрос уже отправлен администратору. Ожидайте.');
        }
      } else {
        await sendMessage(chatId, '⛔ Доступ запрещён');
      }
      return;
    }

    if (!user) {
      await sendMessage(chatId, '❌ Сначала используйте /start');
      return;
    }

    if (user.status !== 'approved') {
      await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается администратором');
      return;
    }

    if (text === '/help') {
      await sendMessage(chatId,
        '📋 <b>Доступные команды:</b>\n\n' +
        '/start - приветствие\n' +
        '/help - это сообщение\n' +
        '/status - проверить статус\n' +
        '/list - показать выбранные категории\n' +
        '/goods - показать список товаров (только названия)\n' +
        '/changes - показать изменения цен за сегодня\n\n' +
        '📝 <i>Для изменения списка категорий обратитесь к администратору</i>'
      );
    } else if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) {
        return;
      }
      
      const categories = user.selected_categories || [];
      const categoriesInfo = categories.length > 0 
        ? `\n📁 Выбранные категории (${categories.length}):\n${categories.map(c => `• ${c}`).join('\n')}` 
        : '\n📁 Категории не выбраны';
      
      await sendMessage(chatId,
        `✅ <b>Статус:</b> подтверждён\n` +
        `🆔 ID: <code>${userId}</code>${categoriesInfo}`
      );
    } else if (text === '/list') {
      if (!checkRateLimit(userId, '/list')) {
        return;
      }
      await showActiveCategories(chatId, user);
    } else if (text === '/goods') {
      if (!checkRateLimit(userId, '/goods')) {
        return;
      }
      
      const selectedCategories = user?.selected_categories || [];
      
      if (selectedCategories.length === 0) {
        await sendMessage(chatId, '❌ У вас нет выбранных категорий');
        return;
      }

      let allProducts = [];
      for (const category of selectedCategories) {
        const products = await getProductsByCategory(category);
        allProducts = [...allProducts, ...products];
      }
      
      if (allProducts.length === 0) {
        await sendMessage(chatId, `📭 В выбранных категориях нет товаров`);
        return;
      }

      const productList = allProducts
        .map(p => formatProductSimple(p))
        .join('\n');

      await sendLongMessage(chatId, 
        `📦 <b>Товары в выбранных категориях (${allProducts.length}):</b>\n\n${productList}`
      );
    } else if (text === '/changes') {
      if (!checkRateLimit(userId, '/changes')) {
        return;
      }
      
      const userCategories = user?.selected_categories || [];
      
      if (userCategories.length === 0) {
        await sendMessage(chatId, '❌ У вас нет выбранных категорий');
        return;
      }
      
      const changes = await getPriceChanges();
      
      // Фильтруем изменения только по категориям пользователя
      const filteredChanges = changes.filter(change => 
        userCategories.includes(change.category)
      );
      
      if (filteredChanges.length === 0) {
        await sendMessage(chatId, '📭 В ваших категориях за сегодня изменений цен не было');
        return;
      }

      await sendMessage(chatId, 
        `📊 <b>Изменения цен в ваших категориях за сегодня (${filteredChanges.length}):</b>`
      );

      for (const change of filteredChanges) {
        await sendMessage(chatId, formatProductFull(change));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      await sendMessage(chatId, '❓ Неизвестная команда. /help');
    }
  } catch (err) {
    console.error('❌ Ошибка в handleMessage:', err);
    await sendMessage(message?.chat?.id, '❌ Произошла внутренняя ошибка. Попробуйте позже.');
  }
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  console.log('📞 Callback получен:', query.data);
  
  try {
    const data = query.data;
    const message = query.message;
    const fromId = query.from.id;

    const user = await getUser(fromId);
    
    if (!user || user.status !== 'approved') {
      // Для выбора категорий при старте разрешаем даже без подтверждения
      if (!data.startsWith('select_cat_') && data !== 'submit_categories' && !data.startsWith('admin_')) {
        await answerCallback(query.id, '⛔ Сначала авторизуйтесь через /start');
        return;
      }
    }

    if (data === 'noop') {
      await answerCallback(query.id, '✅');
      return;
    }

    // ==================== ВЫБОР КАТЕГОРИЙ ПРИ СТАРТЕ ====================
    if (data.startsWith('select_cat_')) {
      const parts = data.split('_');
      const index = parseInt(parts[2]);
      const category = parts.slice(3).join('_');
      
      // Получаем текущие выбранные категории пользователя
      const user = await getUser(fromId);
      let selected = user?.selected_categories || [];
      
      if (!selected.includes(category)) {
        selected.push(category);
        await updateUserCategories(fromId, selected);
        await answerCallback(query.id, `✅ ${category} выбрана`);
      } else {
        // Если уже выбрана - убираем
        selected = selected.filter(c => c !== category);
        await updateUserCategories(fromId, selected);
        await answerCallback(query.id, `❌ ${category} убрана`);
      }
      
      // Показываем обновленный список
      await showCategorySelection(message.chat.id, fromId);
      return;
    }

    if (data === 'submit_categories') {
      const user = await getUser(fromId);
      const selected = user?.selected_categories || [];
      
      if (selected.length === 0) {
        await answerCallback(query.id, '⚠️ Выберите хотя бы одну категорию');
        return;
      }
      
      // Убираем клавиатуру
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });
      
      // Отправляем уведомление админу с выбранными категориями
      await notifyAdminAboutNewUser(fromId, user.username, user.first_name, message.chat.id, selected);
      
      await sendMessage(message.chat.id, 
        '✅ <b>Запрос отправлен администратору!</b>\n\n' +
        `Выбранные категории (${selected.length}):\n` +
        selected.map(c => `• ${c}`).join('\n') +
        '\n\n⏳ Ожидайте подтверждения.'
      );
      
      await answerCallback(query.id, '✅ Запрос отправлен');
      return;
    }

    // ==================== УДАЛЕНИЕ КАТЕГОРИЙ (ДЛЯ ОДОБРЕННЫХ) ====================
    if (data.startsWith('remove_')) {
      const parts = data.split('_');
      const index = parseInt(parts[1]);
      const category = parts.slice(2).join('_');
      
      const selectedCategories = user?.selected_categories || [];
      
      const newCategories = selectedCategories.filter(c => c !== category);
      await updateUserCategories(fromId, newCategories);
      
      await answerCallback(query.id, `❌ ${category} удалена`);
      
      // Показываем обновленный список
      await showActiveCategories(message.chat.id, user);
      return;
    }

    if (data === 'back_to_main') {
      await answerCallback(query.id, '🔙 Возврат');
      await sendMessage(message.chat.id, 
        '👋 Главное меню\n\n' +
        '📋 <b>Команды:</b>\n' +
        '/list - показать выбранные категории\n' +
        '/goods - показать список товаров\n' +
        '/changes - изменения цен за сегодня\n' +
        '/status - проверить статус'
      );
      return;
    }

    // ==================== АДМИНСКИЕ ДЕЙСТВИЯ ====================
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    // Добавление категории админом
    if (data.startsWith('admin_add_')) {
      const parts = data.split('_');
      const userId = parts[2];
      const category = parts.slice(3).join('_');
      
      // Получаем текущие категории пользователя
      const user = await getUser(userId);
      let selected = user?.selected_categories || [];
      
      if (!selected.includes(category)) {
        selected.push(category);
        await updateUserCategories(userId, selected);
      }
      
      // Обновляем сообщение админа
      await updateAdminRequestMessage(message, userId);
      await answerCallback(query.id, `✅ ${category} добавлена`);
      return;
    }

    // Удаление категории админом
    if (data.startsWith('admin_remove_')) {
      const parts = data.split('_');
      const userId = parts[2];
      const category = parts.slice(3).join('_');
      
      // Получаем текущие категории пользователя
      const user = await getUser(userId);
      let selected = user?.selected_categories || [];
      
      selected = selected.filter(c => c !== category);
      await updateUserCategories(userId, selected);
      
      // Обновляем сообщение админа
      await updateAdminRequestMessage(message, userId);
      await answerCallback(query.id, `❌ ${category} удалена`);
      return;
    }

    // Подтверждение
    if (data.startsWith('admin_approve_')) {
      const userId = data.replace('admin_approve_', '');
      const user = await getUser(userId);
      
      if (user) {
        await updateUserStatus(userId, 'approved', 'admin');
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        });

        const categories = user.selected_categories || [];
        const categoriesText = categories.length > 0 
          ? `\n\n📁 <b>Доступные категории:</b>\n${categories.map(c => `• ${c}`).join('\n')}` 
          : '';

        await sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${userId} подтверждён`);
        await sendMessage(user.chat_id, 
          '✅ <b>Доступ подтверждён!</b>' + categoriesText + '\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/list - показать выбранные категории\n' +
          '/goods - показать список товаров\n' +
          '/changes - изменения цен за сегодня\n' +
          '/status - проверить статус\n' +
          '/help - список всех команд'
        );
        await answerCallback(query.id, '✅ Подтверждено');
      }
      return;
    }

    // Отклонение
    if (data.startsWith('admin_reject_')) {
      const userId = data.replace('admin_reject_', '');
      const user = await getUser(userId);
      
      if (user) {
        await updateUserStatus(userId, 'rejected', 'admin');
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        });

        await sendMessage(ADMIN_CHAT_ID, `❌ Пользователь ${userId} отклонён`);
        await sendMessage(user.chat_id, '⛔ <b>Доступ отклонён</b>');
        await answerCallback(query.id, '❌ Отклонено');
      }
      return;
    }

    // Блокировка
    if (data.startsWith('admin_block_')) {
      const userId = data.replace('admin_block_', '');
      const user = await getUser(userId);
      
      if (user) {
        await updateUserStatus(userId, 'blocked', 'admin');
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        });

        await sendMessage(ADMIN_CHAT_ID, `🚫 Пользователь ${userId} заблокирован`);
        await sendMessage(user.chat_id, '🚫 <b>Вы заблокированы</b>');
        await answerCallback(query.id, '🚫 Заблокировано');
      }
      return;
    }

    await answerCallback(query.id, '❓ Неизвестная команда');
    
  } catch (err) {
    console.error('❌ Ошибка в handleCallback:', err);
  }
}

// ==================== ПУБЛИЧНЫЕ ФУНКЦИИ ====================

export async function handleTelegramUpdate(update) {
  console.log('🔄 Получен update от Telegram');
  
  try {
    if (update.message) {
      console.log('💬 Сообщение:', update.message.text);
      await handleMessage(update.message);
    }
    if (update.callback_query) {
      console.log('🔘 Callback:', update.callback_query.data);
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error('❌ Update error:', err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    try {
      const users = await db.execute(`
        SELECT telegram_id, username, first_name, last_name, status, selected_categories,
               requested_at, approved_at, approved_by
        FROM telegram_users
        ORDER BY 
          CASE status
            WHEN 'pending' THEN 1
            WHEN 'approved' THEN 2
            ELSE 3
          END,
          requested_at DESC
      `);
      res.json(users.rows);
    } catch (err) {
      console.error('Ошибка получения пользователей:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
    try {
      const { url } = req.body;
      
      if (!url || !url.startsWith('https://')) {
        return res.status(400).json({ error: 'URL должен начинаться с https://' });
      }

      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}/api/telegram/webhook`
      );
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Ошибка установки webhook:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
      );
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Ошибка получения информации о webhook:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

// ==================== ОТПРАВКА УВЕДОМЛЕНИЙ ====================

export async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.log('⚠️ Telegram не настроен');
    return false;
  }
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    return response.ok;
  } catch (err) {
    console.error('Ошибка отправки уведомления:', err);
    return false;
  }
}

export function formatPriceChangeNotification(product, oldPrice, newPrice) {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const isDecrease = change < 0;
  const circleEmoji = isDecrease ? '🔴' : '🟢';
  const sign = isDecrease ? '' : '+';
  
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
    isDecrease: isDecrease
  });
}
