import fetch from 'node-fetch';
import db from './database.js';

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
    '/list': 2000,
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
      sql: 'SELECT status, chat_id, selected_categories, username, first_name FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
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
    const response = await fetch(`${API_URL}/api/public/categories`, { timeout: 5000 });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.categories || [];
  } catch (err) {
    console.error('Ошибка получения категорий:', err);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ С СЕРВЕРА ====================

async function getProductsFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 10000
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data;
  } catch (err) {
    console.error('Ошибка получения данных:', err);
    return null;
  }
}

// ==================== ПОЛУЧЕНИЕ ИЗМЕНЕНИЙ ЦЕН ====================

async function getPriceChanges() {
  const data = await getProductsFromServer();
  if (!data?.products) return [];
  
  return data.products
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
}

// ==================== ТОВАРЫ ПО КАТЕГОРИИ ====================

async function getProductsByCategory(category) {
  const data = await getProductsFromServer();
  if (!data?.products) return [];
  
  return data.products
    .filter(p => p.category === category)
    .map(p => ({
      code: p.code,
      name: p.name,
      price: p.priceToday || p.packPrice,
      link: p.link
    }));
}

// ==================== ФОРМАТИРОВАНИЕ ====================

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  const formatted = Math.abs(price).toFixed(2).replace('.', ',');
  if (price > 0) return `+${formatted}`;
  if (price < 0) return `-${formatted}`;
  return formatted;
}

function formatProductFull(product) {
  const circleEmoji = product.isDecrease ? '🔴' : '🟢';
  return `
${circleEmoji} <b>${product.product_name}</b>
📋 Код: <code>${product.product_code}</code>
💰 <b>Было:</b> ${formatPrice(product.previous_price)} руб.
💰 <b>Стало:</b> ${formatPrice(product.current_price)} руб. ${circleEmoji} ${formatPrice(product.change)} (${product.percent}%)
💳 РЦ в рассрочку: ${formatPrice(product.packPrice)} руб.
⏱ Срок: ${product.no_overpayment_max_months || '—'} мес.
🔗 <a href="https://www.21vek.by${product.link}">Ссылка</a>
`;
}

// ==================== ВЫБОР КАТЕГОРИЙ ПРИ СТАРТЕ ====================

async function showCategorySelection(chatId, userId) {
  try {
    const categories = await getAllCategories();
    if (!categories.length) {
      await sendMessage(chatId, '📭 В базе пока нет категорий. Обратитесь к администратору.');
      return;
    }

    const user = await getUser(userId);
    const selected = user?.selected_categories || [];

    const buttons = [];
    let row = [];
    
    categories.forEach((cat, index) => {
      const isSelected = selected.includes(cat);
      row.push({
        text: `${isSelected ? '✅ ' : ''}${cat}`,
        callback_data: `select_cat_${index}_${cat}`
      });
      
      if (row.length === 2) {
        buttons.push([...row]);
        row = [];
      }
    });
    
    if (row.length) buttons.push(row);
    buttons.push([{ text: '✅ Готово', callback_data: 'submit_categories' }]);

    const selectedText = selected.length 
      ? `\n\n<b>Выбрано:</b>\n${selected.map(c => `✅ ${c}`).join('\n')}` 
      : '';

    await sendMessage(chatId, 
      `📁 <b>Выберите категории для отслеживания</b>\n` +
      `Нажмите на категорию, чтобы выбрать/убрать её.\nПосле выбора нажмите "Готово".` +
      selectedText, 
      { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('Ошибка в showCategorySelection:', err);
    await sendMessage(chatId, '❌ Ошибка. Попробуйте позже.');
  }
}

// ==================== ПОКАЗ КАТЕГОРИЙ (ТОЛЬКО ПРОСМОТР) ====================

async function showUserCategories(chatId, user) {
  const selected = user?.selected_categories || [];
  if (!selected.length) {
    await sendMessage(chatId, '📭 У вас нет выбранных категорий.');
    return;
  }

  const list = selected.map(c => `• ${c}`).join('\n');
  await sendMessage(chatId, 
    `📋 <b>Ваши категории (${selected.length}):</b>\n\n${list}\n\n` +
    `Для изменения списка обратитесь к администратору.`,
    { parse_mode: 'HTML' }
  );
}

// ==================== УВЕДОМЛЕНИЕ АДМИНА ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId, selectedCategories) {
  console.log('📤 Отправка уведомления админу...', { userId, username, firstName, chatId, selectedCategories });

  if (!ADMIN_CHAT_ID) {
    console.error('❌ ADMIN_CHAT_ID не задан!');
    return;
  }

  const categoriesList = selectedCategories.map(c => `• ${c}`).join('\n');
  
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `📁 <b>Запрошенные категории (${selectedCategories.length}):</b>\n${categoriesList}`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  const allCategories = await getAllCategories();
  
  // Кнопки для удаления
  const removeButtons = selectedCategories.map(cat => ([{
    text: `❌ Убрать ${cat}`,
    callback_data: `admin_remove_${userId}_${cat}`
  }]));

  // Кнопки для добавления
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
  if (row.length) addButtons.push(row);

  const keyboard = {
    inline_keyboard: [
      ...removeButtons,
      ...addButtons,
      [{ text: '✅ Подтвердить', callback_data: `admin_approve_${userId}` }],
      [{ text: '❌ Отклонить', callback_data: `admin_reject_${userId}` }],
      [{ text: '🚫 Заблокировать', callback_data: `admin_block_${userId}` }]
    ]
  };

  await sendMessage(ADMIN_CHAT_ID, `🔔 <b>Новый запрос на доступ!</b>\n\n${info}`, {
    reply_markup: keyboard,
    parse_mode: 'HTML'
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

  const allCategories = await getAllCategories();
  
  const removeButtons = selected.map(cat => ([{
    text: `❌ Убрать ${cat}`,
    callback_data: `admin_remove_${userId}_${cat}`
  }]));

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
  if (row.length) addButtons.push(row);

  const keyboard = {
    inline_keyboard: [
      ...removeButtons,
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

    // ===== START =====
    if (text === '/start') {
      if (!user) {
        await saveUser(userId, username, firstName, lastName, chatId);
        await showCategorySelection(chatId, userId);
      } else if (user.status === 'approved') {
        await sendMessage(chatId, 
          '👋 С возвращением!\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/list - показать мои категории\n' +
          '/goods - список товаров\n' +
          '/changes - изменения цен\n' +
          '/status - статус\n' +
          '/help - помощь'
        );
      } else if (user.status === 'pending') {
        const selected = user.selected_categories || [];
        if (selected.length === 0) {
          await showCategorySelection(chatId, userId);
        } else {
          await sendMessage(chatId, '⏳ Запрос отправлен администратору. Ожидайте.');
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
      await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается');
      return;
    }

    // ===== HELP =====
    if (text === '/help') {
      await sendMessage(chatId,
        '📋 <b>Команды:</b>\n\n' +
        '/start - приветствие\n' +
        '/list - мои категории\n' +
        '/goods - список товаров\n' +
        '/changes - изменения цен\n' +
        '/status - статус\n' +
        '/help - помощь'
      );
    }
    
    // ===== STATUS =====
    else if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) return;
      const categories = user.selected_categories || [];
      const catInfo = categories.length 
        ? `\n📁 Категории (${categories.length}):\n${categories.map(c => `• ${c}`).join('\n')}` 
        : '\n📁 Категории не выбраны';
      await sendMessage(chatId, `✅ <b>Статус:</b> подтверждён\n🆔 ID: <code>${userId}</code>${catInfo}`);
    }
    
    // ===== LIST (только просмотр) =====
    else if (text === '/list') {
      if (!checkRateLimit(userId, '/list')) return;
      await showUserCategories(chatId, user);
    }
    
    // ===== GOODS =====
    else if (text === '/goods') {
      if (!checkRateLimit(userId, '/goods')) return;
      
      const selected = user.selected_categories || [];
      if (!selected.length) {
        await sendMessage(chatId, '❌ У вас нет выбранных категорий');
        return;
      }

      let allProducts = [];
      for (const cat of selected) {
        const products = await getProductsByCategory(cat);
        allProducts = [...allProducts, ...products];
      }
      
      if (!allProducts.length) {
        await sendMessage(chatId, '📭 В ваших категориях нет товаров');
        return;
      }

      const list = allProducts.map(p => `• ${p.name}`).join('\n');
      await sendMessage(chatId, 
        `📦 <b>Товары (${allProducts.length}):</b>\n\n${list}`,
        { parse_mode: 'HTML' }
      );
    }
    
    // ===== CHANGES =====
    else if (text === '/changes') {
      if (!checkRateLimit(userId, '/changes')) return;
      
      const userCategories = user.selected_categories || [];
      if (!userCategories.length) {
        await sendMessage(chatId, '❌ У вас нет выбранных категорий');
        return;
      }
      
      const changes = await getPriceChanges();
      const filtered = changes.filter(c => userCategories.includes(c.category));
      
      if (!filtered.length) {
        await sendMessage(chatId, '📭 В ваших категориях сегодня изменений нет');
        return;
      }

      await sendMessage(chatId, 
        `📊 <b>Изменения за сегодня (${filtered.length}):</b>`
      );

      for (const change of filtered) {
        await sendMessage(chatId, formatProductFull(change));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    else {
      await sendMessage(chatId, '❓ Неизвестная команда. /help');
    }
  } catch (err) {
    console.error('❌ Ошибка в handleMessage:', err);
    await sendMessage(message?.chat?.id, '❌ Внутренняя ошибка');
  }
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  try {
    const data = query.data;
    const message = query.message;
    const fromId = query.from.id;

    const user = await getUser(fromId);

    // Разрешаем выбор категорий без подтверждения
    if (!user && !data.startsWith('select_cat_') && data !== 'submit_categories') {
      await answerCallback(query.id, '⛔ Ошибка');
      return;
    }

    // ===== ВЫБОР КАТЕГОРИЙ =====
    if (data.startsWith('select_cat_')) {
      const parts = data.split('_');
      const category = parts.slice(3).join('_');
      
      const currentUser = await getUser(fromId);
      let selected = currentUser?.selected_categories || [];
      
      if (selected.includes(category)) {
        selected = selected.filter(c => c !== category);
        await answerCallback(query.id, `❌ ${category} убрана`);
      } else {
        selected.push(category);
        await answerCallback(query.id, `✅ ${category} выбрана`);
      }
      
      await updateUserCategories(fromId, selected);
      await showCategorySelection(message.chat.id, fromId);
      return;
    }

    // ===== ОТПРАВКА ЗАПРОСА АДМИНУ =====
    if (data === 'submit_categories') {
      const currentUser = await getUser(fromId);
      const selected = currentUser?.selected_categories || [];
      
      if (!selected.length) {
        await answerCallback(query.id, '⚠️ Выберите категории');
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
      
      // Отправляем уведомление админу
      await notifyAdminAboutNewUser(
        fromId, 
        currentUser.username, 
        currentUser.first_name, 
        message.chat.id, 
        selected
      );
      
      await sendMessage(message.chat.id, 
        '✅ <b>Запрос отправлен!</b>\n\n' +
        selected.map(c => `• ${c}`).join('\n') +
        '\n\n⏳ Ожидайте подтверждения.'
      );
      
      await answerCallback(query.id, '✅ Запрос отправлен');
      return;
    }

    // ===== АДМИНСКИЕ ДЕЙСТВИЯ =====
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    // Добавление категории админом
    if (data.startsWith('admin_add_')) {
      const parts = data.split('_');
      const userId = parts[2];
      const category = parts.slice(3).join('_');
      
      const targetUser = await getUser(userId);
      let selected = targetUser?.selected_categories || [];
      
      if (!selected.includes(category)) {
        selected.push(category);
        await updateUserCategories(userId, selected);
      }
      
      await updateAdminRequestMessage(message, userId);
      await answerCallback(query.id, `✅ ${category} добавлена`);
      return;
    }

    // Удаление категории админом
    if (data.startsWith('admin_remove_')) {
      const parts = data.split('_');
      const userId = parts[2];
      const category = parts.slice(3).join('_');
      
      const targetUser = await getUser(userId);
      let selected = targetUser?.selected_categories || [];
      
      selected = selected.filter(c => c !== category);
      await updateUserCategories(userId, selected);
      
      await updateAdminRequestMessage(message, userId);
      await answerCallback(query.id, `❌ ${category} удалена`);
      return;
    }

    // Подтверждение
    if (data.startsWith('admin_approve_')) {
      const userId = data.replace('admin_approve_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
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

        const categories = targetUser.selected_categories || [];
        const catText = categories.length 
          ? `\n\n📁 <b>Категории:</b>\n${categories.map(c => `• ${c}`).join('\n')}` 
          : '';

        await sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${userId} подтверждён`);
        await sendMessage(targetUser.chat_id, 
          '✅ <b>Доступ подтверждён!</b>' + catText + '\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/list - мои категории\n' +
          '/goods - товары\n' +
          '/changes - изменения цен\n' +
          '/status - статус'
        );
        await answerCallback(query.id, '✅ Подтверждено');
      }
      return;
    }

    // Отклонение
    if (data.startsWith('admin_reject_')) {
      const userId = data.replace('admin_reject_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
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
        await sendMessage(targetUser.chat_id, '⛔ <b>Доступ отклонён</b>');
        await answerCallback(query.id, '❌ Отклонено');
      }
      return;
    }

    // Блокировка
    if (data.startsWith('admin_block_')) {
      const userId = data.replace('admin_block_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
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
        await sendMessage(targetUser.chat_id, '🚫 <b>Вы заблокированы</b>');
        await answerCallback(query.id, '🚫 Заблокировано');
      }
      return;
    }

    await answerCallback(query.id, '❓ Неизвестная команда');
    
  } catch (err) {
    console.error('❌ Ошибка в handleCallback:', err);
  }
}

// ==================== ЭКСПОРТ ====================

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
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
    try {
      const { url } = req.body;
      if (!url?.startsWith('https://')) {
        return res.status(400).json({ error: 'URL должен быть https' });
      }
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}/api/telegram/webhook`
      );
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

export async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return false;
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
    console.error('Ошибка отправки:', err);
    return false;
  }
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
    isDecrease: isDecrease
  });
}
