import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

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
      sql: 'SELECT status, chat_id, selected_categories FROM telegram_users WHERE telegram_id = ?',
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

function formatProductSimple(product) {
  return `• ${product.name}`;
}

// ==================== ВЫБОР КАТЕГОРИЙ ====================

async function showAddCategories(chatId, user) {
  const allCats = await getAllCategories();
  const selected = user?.selected_categories || [];

  const keyboard = [];
  let row = [];

  for (const cat of allCats) {
    if (selected.includes(cat)) continue;
    row.push({
      text: cat,
      callback_data: `add_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);
  keyboard.push([{ text: '✅ Готово', callback_data: 'done_adding' }]);

  const selectedText = selected.length > 0 
    ? `\n\n✅ Уже выбрано:\n${selected.map(c => `• ${c}`).join('\n')}` 
    : '';

  await sendMessage(chatId, 
    `📁 Выбери категории для отслеживания:${selectedText}`, 
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showActiveCategories(chatId, user) {
  const selected = user?.selected_categories || [];
  if (selected.length === 0) {
    await sendMessage(chatId, '📭 У вас нет выбранных категорий.\nИспользуйте /add');
    return;
  }

  const buttons = selected.map(cat => [{
    text: `❌ ${cat}`,
    callback_data: `remove_${cat}`
  }]);

  buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_add' }]);

  await sendMessage(chatId, 
    `📋 Ваши категории (${selected.length}):\nНажмите на категорию чтобы удалить.`, 
    { reply_markup: { inline_keyboard: buttons } }
  );
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  console.log(`📨 ${text} от ${userId}`);

  const user = await getUser(userId);

  if (text === '/start') {
    if (!user) {
      await saveUser(userId, username, firstName, lastName, chatId);
      await sendMessage(chatId, 
        '👋 Привет! Я бот для отслеживания цен.\n\n' +
        '📝 Запрос на доступ отправлен администратору.'
      );
      await notifyAdminAboutNewUser(userId, username, firstName, chatId);
    } else if (user.status === 'approved') {
      await sendMessage(chatId, '👋 С возвращением! /help');
    } else if (user.status === 'pending') {
      await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
    } else {
      await sendMessage(chatId, '⛔ Доступ запрещён');
    }
    return;
  }

  if (!user) {
    await sendMessage(chatId, '❌ Сначала используй /start');
    return;
  }

  if (user.status !== 'approved') {
    await sendMessage(chatId, '⏳ Ваш запрос ещё рассматривается');
    return;
  }

  // === КОМАНДЫ ===
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Команды:</b>\n\n' +
      '/add — выбрать категории\n' +
      '/list — показать выбранные\n' +
      '/goods — список товаров\n' +
      '/changes — изменения цен\n' +
      '/status — профиль'
    );
    return;
  }

if (text === '/status') {
  const categories = user.selected_categories || [];
  const catText = categories.length 
    ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
    : '\n📁 Категории не выбраны';

  // Получаем email, имя, username из БД
  const userInfo = await db.execute({
    sql: 'SELECT email, username, first_name, last_name FROM telegram_users WHERE telegram_id = ?',
    args: [userId]
  });

  const info = userInfo.rows[0] || {};
  const email = info.email || 'не указан';
  const username = info.username ? `@${info.username}` : '—';
  const firstName = info.first_name || '—';
  const lastName = info.last_name || '—';

  await sendMessage(chatId,
    `✅ <b>Статус:</b> подтверждён\n` +
    //`🆔 ID: <code>${userId}</code>\n` +
    `👤 Имя: ${firstName} ${lastName}\n` +
    `📱 Username: ${username}\n` +
    //`📧 Email: <code>${email}</code>${catText}`
  );
  return;
}

  if (text === '/add') {
    await showAddCategories(chatId, user);
    return;
  }

  if (text === '/list') {
    await showActiveCategories(chatId, user);
    return;
  }

  if (text === '/goods') {
    const selected = user.selected_categories || [];
    if (selected.length === 0) {
      await sendMessage(chatId, '❌ Сначала выберите категории через /add');
      return;
    }

    let products = [];
    for (const cat of selected) {
      const data = await getProductsFromServer();
      const catProducts = data?.products?.filter(p => p.category === cat) || [];
      products.push(...catProducts);
    }

    if (products.length === 0) {
      await sendMessage(chatId, '📭 Нет товаров');
      return;
    }

    const list = products.map(p => `• ${p.name}`).join('\n');
    await sendMessage(chatId, `📦 Товаров: ${products.length}\n\n${list}`);
    return;
  }

if (text === '/changes') {
  const selected = user.selected_categories || [];
  if (selected.length === 0) {
    await sendMessage(chatId, '❌ Сначала выберите категории через /add');
    return;
  }

  const data = await getProductsFromServer();
  const changes = data?.products
    .filter(p => 
      selected.includes(p.category) && 
      p.priceToday && 
      p.priceYesterday && 
      Math.abs(p.priceToday - p.priceYesterday) > 0.01
    )
    .map(p => ({
      code: p.code,
      name: p.name,
      priceToday: p.priceToday,
      priceYesterday: p.priceYesterday,
      change: p.priceToday - p.priceYesterday,
      percent: ((p.priceToday - p.priceYesterday) / p.priceYesterday * 100).toFixed(1),
      packPrice: p.packPrice,
      no_overpayment_max_months: p.no_overpayment_max_months,
      link: p.link,
      isDecrease: p.priceToday < p.priceYesterday
    })) || [];

  if (changes.length === 0) {
    await sendMessage(chatId, '📭 В выбранных категориях сегодня нет изменений');
    return;
  }

  await sendMessage(chatId, `📊 Изменений в ваших категориях: ${changes.length}`);

  for (const ch of changes.slice(0, 5)) {
    await sendMessage(chatId, formatProductFull({
      product_code: ch.code,
      product_name: ch.name,
      current_price: ch.priceToday,
      previous_price: ch.priceYesterday,
      change: ch.change,
      percent: ch.percent,
      packPrice: ch.packPrice,
      no_overpayment_max_months: ch.no_overpayment_max_months,
      link: ch.link,
      isDecrease: ch.isDecrease
    }));

    if (changes.length > 5 && ch === changes[4]) {
      await sendMessage(chatId, `... и ещё ${changes.length - 5} изменений.`);
    }
  }
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

  const user = await getUser(fromId);
  if (!user || user.status !== 'approved') {
    await answerCallback(query.id, '⛔ Сначала авторизуйтесь');
    return;
  }

  if (data.startsWith('add_')) {
    const category = data.replace('add_', '');
    const selected = user.selected_categories || [];
    if (!selected.includes(category)) {
      selected.push(category);
      await updateUserCategories(fromId, selected);
      await answerCallback(query.id, `✅ ${category} добавлена`);
    }
    await showAddCategories(msg.chat.id, user);
    return;
  }

  if (data.startsWith('remove_')) {
    const category = data.replace('remove_', '');
    const selected = user.selected_categories || [];
    const updated = selected.filter(c => c !== category);
    await updateUserCategories(fromId, updated);
    await answerCallback(query.id, `❌ ${category} удалена`);
    await showActiveCategories(msg.chat.id, { ...user, selected_categories: updated });
    return;
  }

  if (data === 'back_to_add') {
    await answerCallback(query.id, '🔙 Назад');
    await showAddCategories(msg.chat.id, user);
    return;
  }

  if (data === 'done_adding') {
    await answerCallback(query.id, '✅ Готово');
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

  // Админские кнопки
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Нет прав');
    return;
  }

  if (data.startsWith('approve_')) {
    const userId = data.replace('approve_', '');
    await updateUserStatus(userId, 'approved', 'admin');
    await answerCallback(query.id, '✅ Подтверждён');
    await sendMessage(userId, '✅ Ваш запрос одобрен!');
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

  if (data.startsWith('reject_')) {
    const userId = data.replace('reject_', '');
    await updateUserStatus(userId, 'rejected', 'admin');
    await answerCallback(query.id, '❌ Отклонён');
    await sendMessage(userId, '❌ Доступ отклонён');
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: []
        }
      })
    });
    return;
  }

  if (data.startsWith('block_')) {
    const userId = data.replace('block_', '');
    await updateUserStatus(userId, 'blocked', 'admin');
    await answerCallback(query.id, '🚫 Заблокирован');
    await sendMessage(userId, '🚫 Вы заблокированы');
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
             requested_at, approved_at, approved_by
      FROM telegram_users
      ORDER BY requested_at DESC
    `);
    res.json(users.rows);
  });
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
