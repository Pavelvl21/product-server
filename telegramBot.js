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
    '/add': 2000,
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

async function getCategoriesFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/public/categories`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.categories || [];
  } catch (err) {
    console.error('Ошибка получения категорий:', err);
    return [];
  }
}

// ==================== ФУНКЦИИ ДЛЯ КАТЕГОРИЙ ====================

async function showCategorySelection(chatId, userId, selected = []) {
  const categories = await getCategoriesFromServer();
  
  if (!categories || categories.length === 0) {
    await sendMessage(chatId, '📭 Категории временно недоступны');
    return;
  }

  const keyboard = [];
  let row = [];

  for (const cat of categories) {
    const isSelected = selected.includes(cat);
    row.push({
      text: (isSelected ? '✅ ' : '⬜ ') + cat,
      callback_data: `sel_cat_${userId}_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);

  keyboard.push([{
    text: '✅ Отправить запрос',
    callback_data: `finish_selection_${userId}`
  }]);

  const selectedText = selected.length 
    ? `\n\n✅ Выбрано:\n${selected.map(c => `• ${c}`).join('\n')}` 
    : '';

  await sendMessage(chatId,
    `📁 Выберите категории для отслеживания:${selectedText}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// ==================== ФУНКЦИИ ДЛЯ ПОЛУЧЕНИЯ ДАННЫХ ====================

async function getProductsFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 10000
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error('Ошибка получения данных с сервера:', err);
    return null;
  }
}

async function getPriceChanges() {
  const data = await getProductsFromServer();
  if (!data || !data.products) return [];
  
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

// ==================== ФУНКЦИИ ФОРМАТИРОВАНИЯ ====================

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  const formatted = Math.abs(price).toFixed(2).replace('.', ',');
  if (price > 0) return `+${formatted}`;
  if (price < 0) return `-${formatted}`;
  return formatted;
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
    if (i < parts.length - 1) await new Promise(resolve => setTimeout(resolve, 500));
  }
  return true;
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId, selectedCategories) {
  const categoriesList = selectedCategories.map(c => `• ${c}`).join('\n');
  
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `📁 <b>Запрошенные категории:</b>\n${categoriesList}`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `approve_${userId}` },
      { text: '❌ Отклонить', callback_data: `reject_${userId}` },
      { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
    ]]
  };

  await sendMessage(ADMIN_CHAT_ID, `🔔 <b>Новый запрос на доступ!</b>\n\n${info}`, {
    reply_markup: keyboard
  });
}

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

    // === /start ===
    if (text === '/start') {
      if (!user) {
        // Новый пользователь — создаём и сразу показываем категории
        await saveUser(userId, username, firstName, lastName, chatId);
        await showCategorySelection(chatId, userId, []);
        return;
      }
      
      if (user.status === 'approved') {
        await sendMessage(chatId, 
          '👋 С возвращением!\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/add - изменить категории\n' +
          '/list - показать выбранные категории\n' +
          '/goods - список товаров\n' +
          '/changes - изменения цен\n' +
          '/help - помощь'
        );
        return;
      }
      
      if (user.status === 'pending') {
        // Показываем текущий выбор категорий
        await showCategorySelection(chatId, userId, user.selected_categories || []);
        return;
      }
      
      await sendMessage(chatId, '⛔ Доступ запрещён');
      return;
    }

    // Для всех остальных команд проверяем наличие пользователя
    if (!user) {
      await sendMessage(chatId, '❌ Сначала используйте /start');
      return;
    }

    // Если пользователь в статусе pending — перенаправляем на выбор категорий
    if (user.status === 'pending') {
      await showCategorySelection(chatId, userId, user.selected_categories || []);
      return;
    }

    // Дальше только для approved
    if (user.status !== 'approved') {
      await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается');
      return;
    }

    // === КОМАНДЫ ДЛЯ АВТОРИЗОВАННЫХ ПОЛЬЗОВАТЕЛЕЙ ===
    if (text === '/help') {
      await sendMessage(chatId,
        '📋 <b>Доступные команды:</b>\n\n' +
        '/start - приветствие\n' +
        '/help - это сообщение\n' +
        '/status - проверить статус\n' +
        '/add - изменить категории\n' +
        '/list - показать выбранные категории\n' +
        '/goods - список товаров\n' +
        '/changes - изменения цен'
      );
      return;
    }

    if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) return;
      
      const categories = user.selected_categories || [];
      const categoriesInfo = categories.length > 0 
        ? `\n📁 Выбранные категории (${categories.length}):\n${categories.map(c => `• ${c}`).join('\n')}` 
        : '\n📁 Категории не выбраны';
      
      await sendMessage(chatId,
        `✅ <b>Статус:</b> подтверждён\n` +
        `🆔 ID: <code>${userId}</code>${categoriesInfo}`
      );
      return;
    }

    if (text === '/add') {
      if (!checkRateLimit(userId, '/add')) return;
      await showCategorySelection(chatId, userId, user.selected_categories || []);
      return;
    }

    if (text === '/list') {
      if (!checkRateLimit(userId, '/list')) return;
      
      const selected = user.selected_categories || [];
      if (selected.length === 0) {
        await sendMessage(chatId, '📭 У вас нет выбранных категорий.\nИспользуйте /add');
        return;
      }
      
      const list = selected.map(c => `• ${c}`).join('\n');
      await sendMessage(chatId, `📋 Ваши категории:\n${list}`);
      return;
    }

    if (text === '/goods') {
      if (!checkRateLimit(userId, '/goods')) return;
      
      const selectedCategories = user?.selected_categories || [];
      
      if (selectedCategories.length === 0) {
        await sendMessage(chatId, '❌ Сначала выберите категории через /add');
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
      return;
    }

    if (text === '/changes') {
      if (!checkRateLimit(userId, '/changes')) return;
      
      const userCategories = user.selected_categories || [];
      if (userCategories.length === 0) {
        await sendMessage(chatId, '❌ Сначала выберите категории через /add');
        return;
      }
      
      const changes = await getPriceChanges();
      const filtered = changes.filter(c => userCategories.includes(c.category));
      
      if (filtered.length === 0) {
        await sendMessage(chatId, '📭 В ваших категориях сегодня нет изменений');
        return;
      }

      await sendMessage(chatId, 
        `📊 <b>Изменения в ваших категориях (${filtered.length}):</b>`
      );

      for (const change of filtered) {
        await sendMessage(chatId, formatProductFull(change));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    await sendMessage(chatId, '❓ Неизвестная команда. /help');
    
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

    // Получаем пользователя (может быть null)
    const user = await getUser(fromId);

    // === ВЫБОР КАТЕГОРИИ — доступно даже без авторизации ===
    if (data.startsWith('sel_cat_')) {
      const parts = data.split('_');
      const userId = parseInt(parts[2]);
      const category = parts.slice(3).join('_');

      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser) {
        await answerCallback(query.id, '❌ Пользователь не найден');
        return;
      }

      const selected = currentUser.selected_categories || [];
      const updated = selected.includes(category)
        ? selected.filter(c => c !== category)
        : [...selected, category];

      // Сохраняем в БД через API
      await fetch(`${API_URL}/api/public/user/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: fromId,
          categories: updated
        })
      });

      await answerCallback(query.id, `✅ ${category} ${selected.includes(category) ? 'убрана' : 'добавлена'}`);
      await showCategorySelection(message.chat.id, fromId, updated);
      return;
    }

    // === ЗАВЕРШЕНИЕ ВЫБОРА — отправка запроса админу ===
    if (data.startsWith('finish_selection_')) {
      const userId = parseInt(data.replace('finish_selection_', ''));

      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser) {
        await answerCallback(query.id, '❌ Пользователь не найден');
        return;
      }

      const selected = currentUser.selected_categories || [];
      if (selected.length === 0) {
        await answerCallback(query.id, '⚠️ Выберите хотя бы одну категорию');
        return;
      }

      // Отправляем уведомление админу
      await notifyAdminAboutNewUser(
        fromId, 
        currentUser.username, 
        currentUser.first_name, 
        message.chat.id,
        selected
      );

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

      await sendMessage(message.chat.id, 
        '✅ <b>Запрос отправлен!</b>\n\n' +
        selected.map(c => `• ${c}`).join('\n') + `\n\n` +
        'Ожидайте подтверждения администратора.'
      );

      await answerCallback(query.id, '✅ Запрос отправлен');
      return;
    }

    // === АДМИНСКИЕ КНОПКИ — только для админа ===
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    // Админ подтверждает пользователя
    if (data.startsWith('approve_')) {
      const userId = data.replace('approve_', '');
      
      const targetUser = await getUser(userId);
      
      if (!targetUser) {
        await answerCallback(query.id, '❌ Пользователь не найден');
        return;
      }
      
      // Проверяем, выбраны ли категории
      if (!targetUser.selected_categories || targetUser.selected_categories.length === 0) {
        await answerCallback(query.id, '⚠️ Пользователь не выбрал категории');
        return;
      }
      
      // Подтверждаем
      await updateUserStatus(userId, 'approved', 'admin');
      
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

      await sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${userId} подтверждён`);
      
      if (targetUser.chat_id) {
        await sendMessage(targetUser.chat_id, 
          '✅ <b>Регистрация завершена!</b>\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/add - изменить категории\n' +
          '/list - показать категории\n' +
          '/goods - список товаров\n' +
          '/changes - изменения цен'
        );
      }
      
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
            chat_id: message.chat.id,
            message_id: message.message_id,
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
            chat_id: message.chat.id,
            message_id: message.message_id,
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
