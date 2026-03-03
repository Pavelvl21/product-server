import fetch from 'node-fetch';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Временное хранилище для данных до регистрации
const tempUserData = new Map();

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
    console.error('❌ Telegram send error:', err);
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
    console.error('❌ Callback answer error:', err);
  }
}

// ==================== API-ЗАПРОСЫ К СЕРВЕРУ ====================

async function getCategoriesFromServer() {
  try {
    console.log('🌐 Запрос категорий с сервера');
    const response = await fetch(`${API_URL}/api/public/categories`);
    if (!response.ok) {
      console.error(`❌ Ошибка HTTP: ${response.status}`);
      return [];
    }
    const data = await response.json();
    console.log(`📦 Получено категорий: ${data.length}`);
    return data;
  } catch (err) {
    console.error('❌ Ошибка получения категорий:', err);
    return [];
  }
}

async function registerUserOnServer(telegramId, email, categories, userData) {
  try {
    console.log(`📝 Регистрация пользователя ${telegramId} на сервере`);
    const response = await fetch(`${API_URL}/api/public/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramId,
        email,
        categories,
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error(`❌ Ошибка регистрации: ${error.error}`);
      return false;
    }

    console.log(`✅ Пользователь ${telegramId} зарегистрирован на сервере`);
    return true;
  } catch (err) {
    console.error('❌ Ошибка при регистрации:', err);
    return false;
  }
}

async function getUserStatusFromServer(telegramId) {
  try {
    const response = await fetch(`${API_URL}/api/public/user/${telegramId}`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('❌ Ошибка получения статуса:', err);
    return null;
  }
}

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

export async function notifyAdminAboutNewUser(user) {
  const categories = JSON.parse(user.selected_categories || '[]');
  const catsText = categories.length 
    ? categories.map(c => `• ${c}`).join('\n') 
    : '—';

  const text = `
🔔 <b>Новый запрос доступа</b>

👤 <b>${user.first_name || '—'} ${user.last_name || ''}</b>
📱 Username: ${user.username ? '@' + user.username : '—'}
🆔 ID: <code>${user.telegram_id}</code>
📧 Email: <code>${user.email || '—'}</code>

📋 Выбранные категории:
${catsText}
`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `approve_${user.telegram_id}` },
      { text: '❌ Отклонить', callback_data: `reject_${user.telegram_id}` }
    ], [
      { text: '🚫 Заблокировать', callback_data: `block_${user.telegram_id}` }
    ]]
  };

  await sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: keyboard
  });
}

// ==================== ВЫБОР КАТЕГОРИЙ ====================

async function showCategorySelection(chatId, userId, selected = []) {
  console.log(`🎯 Показ категорий для ${userId}`);

  const allCats = await getCategoriesFromServer();

  if (!allCats || allCats.length === 0) {
    await sendMessage(chatId, '❌ Категории временно недоступны. Попробуй позже.');
    return;
  }

  const keyboard = [];
  let row = [];

  for (const cat of allCats) {
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
    text: '📬 Отправить запрос',
    callback_data: `send_request_${userId}`
  }]);

  const selectedText = selected.length 
    ? `\n\n✅ Уже выбрано:\n${selected.map(c => `• ${c}`).join('\n')}` 
    : '';

  await sendMessage(chatId,
    `📁 Выбери категории для отслеживания:${selectedText}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  console.log(`\n📨 Сообщение от ${userId}: ${text}`);

  // Получаем статус пользователя с сервера
  const userStatus = await getUserStatusFromServer(userId);

  // === /start ===
  if (text === '/start') {
    if (userStatus) {
      console.log(`👤 Пользователь ${userId} существует, статус: ${userStatus.status}`);
      
      if (userStatus.status === 'approved') {
        await sendMessage(chatId, '👋 С возвращением! /help');
        return;
      }
      if (userStatus.status === 'pending') {
        await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
        return;
      }
      if (userStatus.status === 'rejected') {
        await sendMessage(chatId, '⛔ Ваш запрос был отклонён');
        return;
      }
      if (userStatus.status === 'blocked') {
        await sendMessage(chatId, '🚫 Вы заблокированы');
        return;
      }
    }

    // Новый пользователь
    console.log(`🆕 Новый пользователь ${userId}`);
    tempUserData.set(userId, { username, firstName, lastName, chatId, selected: [] });
    await sendMessage(chatId,
      '👋 Привет! Для доступа укажи свой корпоративный email (@patio-minsk.by)\n\n✉️ Отправь его:'
    );
    return;
  }

  // === Ожидание email ===
  if (!userStatus && tempUserData.has(userId)) {
    const email = text.trim().toLowerCase();

    if (!email.endsWith('@patio-minsk.by')) {
      await sendMessage(chatId, '❌ Допустимы только email @patio-minsk.by');
      return;
    }

    const data = tempUserData.get(userId);
    data.email = email;
    tempUserData.set(userId, data);

    console.log(`✅ Email ${email} принят для ${userId}`);
    await sendMessage(chatId, '✅ Email принят. Теперь выбери категории.');
    await showCategorySelection(chatId, userId, []);
    return;
  }

  // === Если не авторизован ===
  if (!userStatus || userStatus.status !== 'approved') {
    await sendMessage(chatId, '❌ Сначала используй /start');
    return;
  }

  // === Команды для авторизованных ===
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Команды:</b>\n\n' +
      '/status — профиль\n' +
      '/add — выбрать категории\n' +
      '/list — показать выбранные'
    );
    return;
  }

  if (text === '/status') {
    const catText = userStatus.categories?.length 
      ? `\n📁 Категории:\n${userStatus.categories.map(c => `• ${c}`).join('\n')}` 
      : '\n📁 Категории не выбраны';

    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📧 Email: <code>${userStatus.email || '—'}</code>${catText}`
    );
    return;
  }

  if (text === '/add') {
    await showCategorySelection(chatId, userId, userStatus.categories || []);
    return;
  }

  if (text === '/list') {
    const selected = userStatus.categories || [];
    if (selected.length === 0) {
      await sendMessage(chatId, '📭 Категории не выбраны. /add');
      return;
    }
    const list = selected.map(c => `• ${c}`).join('\n');
    await sendMessage(chatId, `📋 Ваши категории:\n${list}`);
    return;
  }

  await sendMessage(chatId, '❓ Неизвестная команда. /help');
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  console.log(`\n🔘 Callback от ${fromId}: ${data}`);

  // === Выбор категории пользователем ===
  if (data.startsWith('sel_cat_')) {
    const parts = data.split('_');
    const targetUserId = parseInt(parts[2]);
    const category = parts.slice(3).join('_');

    if (targetUserId !== fromId) {
      await answerCallback(query.id, '⛔ Это не твоя сессия');
      return;
    }

    const userData = tempUserData.get(fromId);
    if (!userData) {
      await answerCallback(query.id, '❌ Сессия не найдена');
      return;
    }

    const selected = userData.selected || [];
    const updated = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category];

    userData.selected = updated;
    tempUserData.set(fromId, userData);

    await answerCallback(query.id, `✅ ${category} ${selected.includes(category) ? 'убрана' : 'добавлена'}`);
    await showCategorySelection(msg.chat.id, fromId, updated);
    return;
  }

  // === Отправка запроса ===
  if (data.startsWith('send_request_')) {
    const userData = tempUserData.get(fromId);
    
    if (!userData || !userData.email) {
      await answerCallback(query.id, '❌ Данные не найдены');
      return;
    }

    const success = await registerUserOnServer(
      fromId,
      userData.email,
      userData.selected || [],
      userData
    );

    if (success) {
      await answerCallback(query.id, '📬 Запрос отправлен');
      await sendMessage(msg.chat.id, '📬 Запрос отправлен администратору. Ожидайте.');
      tempUserData.delete(fromId);
    } else {
      await answerCallback(query.id, '❌ Ошибка при регистрации');
    }
    return;
  }

  // === Админские кнопки ===
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Только для админа');
    return;
  }

  // Здесь можно добавить логику подтверждения/отклонения
  // Но она уже есть в старом коде, оставляем как есть

  await answerCallback(query.id, '✅ Обработано');
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
  // Эндпоинты для админки
}

export async function sendMessageToAdmin(message) {
  return await sendMessage(ADMIN_CHAT_ID, message);
}
