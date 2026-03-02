import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
        ...options
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

async function sendWithKeyboard(chatId, text, buttons) {
  if (!BOT_TOKEN) return false;
  
  const keyboard = {
    inline_keyboard: buttons.map(b => [{
      text: b.text,
      callback_data: b.callback_data
    }])
  };

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram keyboard error:', err);
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
        text: text
      })
    });
  } catch (err) {
    console.error('Callback answer error:', err);
  }
}

// ==================== РАБОТА С БД ====================

async function getUser(telegramId) {
  const result = await db.execute({
    sql: 'SELECT status, chat_id, selected_category FROM telegram_users WHERE telegram_id = ?',
    args: [telegramId]
  });
  return result.rows[0];
}

async function saveUser(telegramId, username, firstName, lastName, chatId) {
  await db.execute({
    sql: `INSERT INTO telegram_users (telegram_id, username, first_name, last_name, chat_id, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
          ON CONFLICT(telegram_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            chat_id = excluded.chat_id,
            status = CASE 
              WHEN status = 'rejected' THEN 'pending' 
              ELSE status 
            END,
            requested_at = CURRENT_TIMESTAMP`,
    args: [telegramId, username || '', firstName || '', lastName || '', chatId]
  });
}

async function updateUserStatus(telegramId, status, approvedBy = null) {
  const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL';
  await db.execute({
    sql: `UPDATE telegram_users 
          SET status = ?, 
              approved_at = ${approvedAt},
              approved_by = ?
          WHERE telegram_id = ?`,
    args: [status, approvedBy, telegramId]
  });
}

async function updateUserCategory(telegramId, category) {
  await db.execute({
    sql: 'UPDATE telegram_users SET selected_category = ? WHERE telegram_id = ?',
    args: [category, telegramId]
  });
}

// ==================== НОВЫЕ ФУНКЦИИ ====================

async function getAllCategories() {
  const result = await db.execute(`
    SELECT DISTINCT category 
    FROM products_info 
    WHERE category IS NOT NULL 
    ORDER BY category
  `);
  return result.rows.map(row => row.category);
}

async function getProductsByCategory(category) {
  const result = await db.execute({
    sql: `
      SELECT 
        code,
        name,
        last_price,
        packPrice,
        monthly_payment,
        no_overpayment_max_months,
        link
      FROM products_info 
      WHERE category = ?
      ORDER BY name
    `,
    args: [category]
  });
  return result.rows;
}

function formatProductMessage(product) {
  const formatPrice = (price) => {
    return price ? price.toFixed(2).replace('.', ',') : '—';
  };

  const rows = [
    `🛍 <b>${product.name}</b>`,
    ``,
    `📋 Код товара: <code>${product.code}</code>`,
    `💰 РЦ: ${formatPrice(product.last_price)} руб.`,
    `💳 Цена в рассрочку: ${formatPrice(product.packPrice)} руб.`,
    `📆 Платеж: ${product.monthly_payment ? product.monthly_payment.replace('.', ',') : '—'} руб./мес`,
    `⏱ Рассрочка: ${product.no_overpayment_max_months || '—'} мес.`,
    `🔗 <a href="${product.link}">Ссылка на товар</a>`
  ];

  return rows.join('\n');
}

// ==================== ОБРАБОТЧИКИ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  await sendWithKeyboard(
    ADMIN_CHAT_ID,
    `🔔 <b>Новый запрос на доступ!</b>\n\n${info}`,
    [
      { text: '✅ Разрешить', callback_data: `approve_${userId}` },
      { text: '❌ Отклонить', callback_data: `reject_${userId}` },
      { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
    ]
  );
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  const user = await getUser(userId);

  // /start всегда доступен
  if (text === '/start') {
    if (!user) {
      await saveUser(userId, username, firstName, lastName, chatId);
      await sendMessage(chatId, 
        '👋 Привет! Я бот для отслеживания цен.\n\n' +
        '📝 <b>Запрос на доступ отправлен администратору.</b>\n' +
        'Ожидайте подтверждения.'
      );
      await notifyAdminAboutNewUser(userId, username, firstName, chatId);
    } else if (user.status === 'approved') {
      await sendMessage(chatId, '👋 С возвращением!\n\n/help - список команд');
    } else if (user.status === 'pending') {
      await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
    } else {
      await sendMessage(chatId, '⛔ Доступ запрещён');
    }
    return;
  }

  // Для неподтверждённых игнорируем
  if (!user || user.status !== 'approved') return;

  // Команды для подтверждённых
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Доступные команды:</b>\n\n' +
      '/start - приветствие\n' +
      '/help - это сообщение\n' +
      '/status - проверить статус\n' +
      '/select - выбрать категорию товаров\n' +
      '/goods - показать товары из выбранной категории'
    );
  } else if (text === '/status') {
    const categoryInfo = user.selected_category 
      ? `\n📁 Выбранная категория: ${user.selected_category}` 
      : '\n📁 Категория не выбрана';
    
    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🆔 ID: <code>${userId}</code>${categoryInfo}`
    );
  } else if (text === '/select') {
    const categories = await getAllCategories();
    
    if (categories.length === 0) {
      await sendMessage(chatId, '📭 В базе пока нет категорий');
      return;
    }

    // Разбиваем на ряды по 2 кнопки для компактности
    const buttons = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row = [];
      row.push({ text: categories[i], callback_data: `cat_${categories[i]}` });
      if (i + 1 < categories.length) {
        row.push({ text: categories[i + 1], callback_data: `cat_${categories[i + 1]}` });
      }
      buttons.push(row);
    }

    const keyboard = {
      inline_keyboard: buttons
    };

    await sendMessage(chatId, '📁 Выберите категорию:', { reply_markup: keyboard });
  } else if (text === '/goods') {
    if (!user.selected_category) {
      await sendMessage(chatId, '❌ Сначала выберите категорию через /select');
      return;
    }

    const products = await getProductsByCategory(user.selected_category);
    
    if (products.length === 0) {
      await sendMessage(chatId, `📭 В категории "${user.selected_category}" нет товаров`);
      return;
    }

    await sendMessage(chatId, `📦 Найдено товаров: ${products.length}\nОтправляю список...`);

    // Отправляем товары по одному (чтобы не превысить лимит Telegram)
    for (const product of products) {
      const productText = formatProductMessage(product);
      await sendMessage(chatId, productText);
      // Небольшая задержка, чтобы не флудить
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } else {
    await sendMessage(chatId, '❓ Неизвестная команда. /help');
  }
}

async function handleCallback(query) {
  const data = query.data;
  const message = query.message;
  const fromId = query.from.id;

  // Обработка выбора категории
  if (data.startsWith('cat_')) {
    const category = data.replace('cat_', '');
    await updateUserCategory(fromId, category);
    
    // Убираем кнопки
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });

    await answerCallback(query.id, `✅ Категория "${category}" выбрана`);
    await sendMessage(message.chat.id, `✅ Категория "${category}" сохранена. Теперь можете использовать /goods`);
    return;
  }

  // Дальше только админские кнопки
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Нет прав');
    return;
  }

  if (data.startsWith('approve_')) {
    const userId = data.replace('approve_', '');
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

      await sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${userId} подтверждён`);
      await sendMessage(user.chat_id, 
        '✅ <b>Доступ подтверждён!</b>\n\nТеперь вы можете пользоваться ботом.\n/help'
      );
    }
  } else if (data.startsWith('reject_')) {
    const userId = data.replace('reject_', '');
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
    }
  } else if (data.startsWith('block_')) {
    const userId = data.replace('block_', '');
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
    }
  }

  await answerCallback(query.id, '✅ Готово');
}

// ==================== ПУБЛИЧНЫЕ ФУНКЦИИ ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('Update error:', err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    const users = await db.execute(`
      SELECT telegram_id, username, first_name, last_name, status, selected_category,
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
  });

  app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL обязателен' });

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}/api/telegram/webhook`
    );
    const data = await response.json();
    res.json(data);
  });

  app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    );
    const data = await response.json();
    res.json(data);
  });
}

// ==================== ОТПРАВКА УВЕДОМЛЕНИЙ ====================

export async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.log('⚠️ Telegram не настроен');
    return false;
  }
  
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
}

export function formatPriceChangeNotification(product, oldPrice, newPrice, changeType = 'изменилась') {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const emoji = change < 0 ? '🔻' : '📈';
  const sign = change > 0 ? '+' : '';
  
  const link = product.link ? `\n<a href="${product.link}">🔗 Ссылка</a>` : '';

  return `
<b>${emoji} Цена ${changeType}!</b>

<b>${product.name}</b>
Код: <code>${product.code}</code>

Старая: ${oldPrice.toFixed(2)} руб.
Новая: ${newPrice.toFixed(2)} руб.
Изменение: ${sign}${change.toFixed(2)} руб. (${sign}${percent}%)${link}

🕐 ${new Date().toLocaleString('ru-RU')}
`;
}
