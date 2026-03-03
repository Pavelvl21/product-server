import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Временное хранилище для данных до сохранения
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

// ==================== РАБОТА С БД ПОЛЬЗОВАТЕЛЕЙ ====================

async function getUser(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories, email FROM telegram_users WHERE telegram_id = ?',
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

async function saveUser(telegramId, username, firstName, lastName, chatId, email) {
  try {
    await db.execute({
      sql: `INSERT INTO telegram_users 
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories, email)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [telegramId, username || '', firstName || '', lastName || '', chatId, '[]', email]
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

// ==================== ДОБАВЛЕНИЕ EMAIL В allowed_emails ====================

async function addEmailToAllowedList(email) {
  try {
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });
    console.log(`✅ Email ${email} добавлен в allowed_emails`);
  } catch (err) {
    console.error('Ошибка добавления email в allowed_emails:', err);
  }
}

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ ====================

async function getAllCategories() {
  try {
    const data = await getProductsFromServer();
    if (!data?.products) return [];
    const cats = [...new Set(data.products.map(p => p.category || 'Без категории'))];
    return cats.sort();
  } catch {
    return [];
  }
}

async function getProductsFromServer() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 5000
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ==================== ФОРМАТИРОВАНИЕ ====================

function formatUserInfo(user) {
  return `
👤 <b>${user.first_name || '—'} ${user.last_name || ''}</b>
📱 Username: ${user.username ? '@' + user.username : '—'}
🆔 ID: <code>${user.telegram_id}</code>
📧 Email: <code>${user.email || '—'}</code>
`;
}

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

async function notifyAdminAboutRequest(userId) {
  const user = await getUser(userId);
  if (!user) return;

  const allCats = await getAllCategories();
  const selected = user.selected_categories || [];

  const keyboard = [];

  let row = [];
  for (const cat of allCats) {
    const isSel = selected.includes(cat);
    row.push({
      text: (isSel ? '✅ ' : '⬜ ') + cat,
      callback_data: `mod_cat_${userId}_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);

  keyboard.push([
    { text: '✅ Разрешить', callback_data: `mod_approve_${userId}` },
    { text: '❌ Отклонить', callback_data: `mod_reject_${userId}` }
  ]);
  keyboard.push([
    { text: '🚫 Заблокировать', callback_data: `mod_block_${userId}` }
  ]);

  const text = `🔔 <b>Новый запрос доступа</b>\n\n${formatUserInfo(user)}\n📋 Выбранные категории (можно изменить):`;

  await sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ==================== ВЫБОР КАТЕГОРИЙ ПОЛЬЗОВАТЕЛЕМ ====================

async function showAddCategories(chatId, userId) {
  const user = await getUser(userId);
  const allCats = await getAllCategories();
  const selected = user?.selected_categories || [];

  const keyboard = [];
  let row = [];

  for (const cat of allCats) {
    if (selected.includes(cat)) continue;
    row.push({
      text: cat,
      callback_data: `add_cat_${userId}_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);
  keyboard.push([{ text: '✅ Отправить запрос', callback_data: `send_request_${userId}` }]);

  const text = `📁 Выбери категории для отслеживания:\n${
    selected.length ? `\n✅ Уже выбрано:\n${selected.map(c => `• ${c}`).join('\n')}` : ''
  }`;

  await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
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

  const user = await getUser(userId);

  // === /start ===
  if (text === '/start') {
    // Если пользователь уже есть в БД
    if (user) {
      if (user.status === 'approved') {
        await sendMessage(chatId, '👋 С возвращением! /help');
        return;
      }

      if (user.status === 'pending') {
        // Проверяем, нет ли email в белом списке
        const allowed = await db.execute({
          sql: 'SELECT * FROM allowed_emails WHERE email = ?',
          args: [user.email]
        });

        if (allowed.rows.length > 0) {
          // Автоматически подтверждаем
          await updateUserStatus(userId, 'approved', 'system');
          await sendMessage(chatId, '✅ Ваш email уже в белом списке. Доступ автоматически подтверждён!');
          await showAddCategories(chatId, userId);
        } else {
          await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
        }
        return;
      }

      if (user.status === 'rejected') {
        await sendMessage(chatId, '⛔ Ваш запрос был отклонён');
        return;
      }

      if (user.status === 'blocked') {
        await sendMessage(chatId, '🚫 Вы заблокированы');
        return;
      }
    }

    // Новый пользователь
    tempUserData.set(userId, { username, firstName, lastName, chatId });
    await sendMessage(chatId,
      '👋 Привет! Для доступа к боту укажи свой корпоративный email (@patio-minsk.by)\n\n' +
      '✉️ Отправь его в ответном сообщении:'
    );
    return;
  }

  // === Ожидание email от нового пользователя ===
  if (!user && tempUserData.has(userId)) {
    const email = text.trim().toLowerCase();

    if (!email.endsWith('@patio-minsk.by')) {
      await sendMessage(chatId, '❌ Допустимы только корпоративные email @patio-minsk.by');
      return;
    }

    const data = tempUserData.get(userId);
    await saveUser(userId, data.username, data.firstName, data.lastName, data.chatId, email);
    tempUserData.delete(userId);

    await sendMessage(chatId, '✅ Email принят. Теперь выбери категории товаров для отслеживания.');
    await showAddCategories(chatId, userId);
    return;
  }

  // Если пользователь не авторизован
  if (!user || user.status !== 'approved') {
    await sendMessage(chatId, '❌ Сначала используй /start');
    return;
  }

  // TODO: сюда можно добавить /help, /list, /changes и т.д.
  await sendMessage(chatId, '❓ Неизвестная команда. /help');
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  console.log('📞 Callback:', data);

  // === Добавление категории пользователем ===
  if (data.startsWith('add_cat_')) {
    const parts = data.split('_');
    const userId = parts[2];
    const category = parts.slice(3).join('_');

    const user = await getUser(userId);
    const selected = user?.selected_categories || [];

    if (!selected.includes(category)) {
      selected.push(category);
      await updateUserCategories(userId, selected);
      await answerCallback(query.id, `✅ ${category} добавлена`);
    } else {
      await answerCallback(query.id, `⚠️ Уже есть`);
    }

    await showAddCategories(msg.chat.id, userId);
    return;
  }

  // === Отправка запроса админу ===
  if (data.startsWith('send_request_')) {
    const userId = data.replace('send_request_', '');
    await notifyAdminAboutRequest(userId);
    await answerCallback(query.id, '📬 Запрос отправлен');
    await sendMessage(msg.chat.id, '📬 Запрос отправлен администратору. Ожидайте.');
    return;
  }

  // === Модерация — только админ ===
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Только для админа');
    return;
  }

  // === Изменение категории админом ===
  if (data.startsWith('mod_cat_')) {
    const parts = data.split('_');
    const userId = parts[2];
    const category = parts.slice(3).join('_');

    const user = await getUser(userId);
    let selected = user?.selected_categories || [];

    if (selected.includes(category)) {
      selected = selected.filter(c => c !== category);
    } else {
      selected.push(category);
    }

    await updateUserCategories(userId, selected);
    await answerCallback(query.id, '✅ Обновлено');
    await notifyAdminAboutRequest(userId); // обновить сообщение админа
    return;
  }

  // === Подтверждение ===
  if (data.startsWith('mod_approve_')) {
    const userId = data.replace('mod_approve_', '');
    const user = await getUser(userId);

    if (user?.email) {
      await addEmailToAllowedList(user.email);
    }

    await updateUserStatus(userId, 'approved', 'admin');
    await answerCallback(query.id, '✅ Подтверждено');
    await sendMessage(userId, '✅ Ваш запрос одобрен! /help');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  // === Отклонение ===
  if (data.startsWith('mod_reject_')) {
    const userId = data.replace('mod_reject_', '');
    await updateUserStatus(userId, 'rejected', 'admin');
    await answerCallback(query.id, '❌ Отклонено');
    await sendMessage(userId, '❌ Ваш запрос отклонён');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  // === Блокировка ===
  if (data.startsWith('mod_block_')) {
    const userId = data.replace('mod_block_', '');
    await updateUserStatus(userId, 'blocked', 'admin');
    await answerCallback(query.id, '🚫 Заблокирован');
    await sendMessage(userId, '🚫 Вы заблокированы');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  await answerCallback(query.id, '❓ Неизвестная команда');
}

// ==================== ОБРАБОТЧИК ОБНОВЛЕНИЙ ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('❌ Update error:', err);
  }
}

// ==================== ЭНДПОИНТЫ ДЛЯ ФРОНТА ====================

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    try {
      const users = await db.execute(`
        SELECT telegram_id, username, first_name, last_name, email, status, selected_categories,
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
}
