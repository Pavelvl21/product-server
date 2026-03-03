import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Временное хранилище для email до сохранения
const tempEmail = new Map();

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
    console.error('❌ Ошибка в getUser:', err);
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
    console.log(`✅ Пользователь ${telegramId} сохранён`);
  } catch (err) {
    console.error('❌ Ошибка сохранения пользователя:', err);
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
    console.log(`✅ Статус ${telegramId} обновлён на ${status}`);
  } catch (err) {
    console.error('❌ Ошибка обновления статуса:', err);
  }
}

async function updateUserCategories(telegramId, categories) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
    console.log(`✅ Категории для ${telegramId} обновлены`);
  } catch (err) {
    console.error('❌ Ошибка обновления категорий:', err);
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
    console.error('❌ Ошибка добавления email в allowed_emails:', err);
  }
}

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ ====================

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

// ==================== ВЫБОР КАТЕГОРИЙ ПОЛЬЗОВАТЕЛЕМ ====================

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

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

async function notifyAdminAboutNewUser(telegramId, email, categories, userData) {
  const catsText = categories.length 
    ? categories.map(c => `• ${c}`).join('\n') 
    : '—';

  const text = `
🔔 <b>Новый запрос доступа</b>

👤 <b>${userData.firstName || '—'} ${userData.lastName || ''}</b>
📱 Username: ${userData.username ? '@' + userData.username : '—'}
🆔 ID: <code>${telegramId}</code>
📧 Email: <code>${email}</code>

📋 Выбранные категории:
${catsText}
`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `approve_${telegramId}` },
      { text: '❌ Отклонить', callback_data: `reject_${telegramId}` }
    ], [
      { text: '🚫 Заблокировать', callback_data: `block_${telegramId}` }
    ]]
  };

  await sendMessage(ADMIN_CHAT_ID, text, {
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

  console.log(`\n📨 Сообщение от ${userId}: ${text}`);

  const user = await getUser(userId);

  // === /start ===
  if (text === '/start') {
    if (user) {
      if (user.status === 'approved') {
        await sendMessage(chatId, '👋 С возвращением! /help');
        return;
      }
      if (user.status === 'pending') {
        await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
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
    tempEmail.set(userId, { username, firstName, lastName, chatId, selected: [] });
    await sendMessage(chatId,
      '👋 Привет! Для доступа укажи свой корпоративный email (@patio-minsk.by)\n\n✉️ Отправь его:'
    );
    return;
  }

  // === Ожидание email ===
  if (!user && tempEmail.has(userId)) {
    const email = text.trim().toLowerCase();

    if (!email.endsWith('@patio-minsk.by')) {
      await sendMessage(chatId, '❌ Допустимы только email @patio-minsk.by');
      return;
    }

    const data = tempEmail.get(userId);
    data.email = email;
    tempEmail.set(userId, data);

    console.log(`✅ Email ${email} принят для ${userId}`);
    await sendMessage(chatId, '✅ Email принят. Теперь выбери категории.');
    await showCategorySelection(chatId, userId, []);
    return;
  }

  // === Если не авторизован ===
  if (!user || user.status !== 'approved') {
    await sendMessage(chatId, '❌ Сначала используй /start');
    return;
  }

  // === Команды ===
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Команды:</b>\n\n' +
      '/status — профиль\n' +
      '/add — выбрать категории\n' +
      '/list — показать выбранные\n' +
      '/goods — список товаров (скоро)\n' +
      '/changes — изменения цен (скоро)'
    );
    return;
  }

  if (text === '/status') {
    const categories = user.selected_categories || [];
    const catText = categories.length 
      ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
      : '\n📁 Категории не выбраны';

    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📧 Email: <code>${user.email || '—'}</code>${catText}`
    );
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

  // === Добавление/удаление категории пользователем ===
  if (data.startsWith('sel_cat_')) {
    const parts = data.split('_');
    const targetUserId = parseInt(parts[2]);
    const category = parts.slice(3).join('_');

    if (targetUserId !== fromId) {
      await answerCallback(query.id, '⛔ Это не твоя сессия');
      return;
    }

    const userData = tempEmail.get(fromId);
    if (!userData) {
      await answerCallback(query.id, '❌ Сессия не найдена');
      return;
    }

    const selected = userData.selected || [];
    const updated = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category];

    userData.selected = updated;
    tempEmail.set(fromId, userData);

    await answerCallback(query.id, `✅ ${category} ${selected.includes(category) ? 'убрана' : 'добавлена'}`);
    await showCategorySelection(msg.chat.id, fromId, updated);
    return;
  }

  // === Отправка запроса ===
  if (data.startsWith('send_request_')) {
    const userData = tempEmail.get(fromId);
    
    if (!userData || !userData.email) {
      await answerCallback(query.id, '❌ Данные не найдены');
      return;
    }

    // Здесь должен быть вызов API регистрации
    await answerCallback(query.id, '📬 Запрос отправлен');
    await sendMessage(msg.chat.id, '📬 Запрос отправлен администратору. Ожидайте.');
    
    await notifyAdminAboutNewUser(
      fromId,
      userData.email,
      userData.selected || [],
      userData
    );
    
    tempEmail.delete(fromId);
    return;
  }

  // === Админские кнопки ===
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Только для админа');
    return;
  }

  if (data.startsWith('approve_')) {
    const targetUserId = data.replace('approve_', '');
    await updateUserStatus(targetUserId, 'approved', 'admin');
    await answerCallback(query.id, '✅ Подтверждён');
    await sendMessage(targetUserId, '✅ Ваш запрос одобрен! /help');
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

  if (data.startsWith('reject_')) {
    const targetUserId = data.replace('reject_', '');
    await updateUserStatus(targetUserId, 'rejected', 'admin');
    await answerCallback(query.id, '❌ Отклонён');
    await sendMessage(targetUserId, '❌ Ваш запрос отклонён');
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  if (data.startsWith('block_')) {
    const targetUserId = data.replace('block_', '');
    await updateUserStatus(targetUserId, 'blocked', 'admin');
    await answerCallback(query.id, '🚫 Заблокирован');
    await sendMessage(targetUserId, '🚫 Вы заблокированы');
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
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
  console.log('🔌 Бот эндпоинты настроены');
}

export async function sendTelegramMessage(message) {
  return await sendMessage(ADMIN_CHAT_ID, message);
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
    no_overpayment_max_months: product.no_overpayment_max_months,
    link: product.link,
    isDecrease: isDecrease
  });
}
