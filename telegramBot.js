import fetch from 'node-fetch';
import db from './database.js';

// ==================== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ TELEGRAM API ====================

// Отправка обычного сообщения
async function sendMessage(chatId, text, options = {}) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...options
      })
    });
    return await response.json();
  } catch (error) {
    console.error('Ошибка отправки:', error);
    return null;
  }
}

// Отправка сообщения с инлайн-кнопками
async function sendMessageWithKeyboard(chatId, text, buttons) {
  const keyboard = {
    inline_keyboard: buttons.map(button => [{
      text: button.text,
      callback_data: button.callback_data
    }])
  };

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    });
    return await response.json();
  } catch (error) {
    console.error('Ошибка отправки с кнопками:', error);
    return null;
  }
}

// Ответ на callback (нажатие кнопки)
async function answerCallbackQuery(callbackQueryId, text) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: false
      })
    });
  } catch (error) {
    console.error('Ошибка ответа на callback:', error);
  }
}

// Удаление кнопок у сообщения
async function editMessageReplyMarkup(chatId, messageId) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      })
    });
  } catch (error) {
    console.error('Ошибка редактирования:', error);
  }
}

// ==================== РАБОТА С БАЗОЙ ДАННЫХ ====================

// Получение статуса пользователя
async function getUserStatus(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    return result.rows[0] || null;
  } catch (error) {
    console.error('Ошибка проверки статуса:', error);
    return null;
  }
}

// Сохранение нового пользователя
async function saveUser(telegramId, username, firstName, lastName, chatId) {
  try {
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
  } catch (error) {
    console.error('Ошибка сохранения пользователя:', error);
  }
}

// Обновление статуса пользователя
async function updateUserStatus(telegramId, status, approvedBy = null) {
  try {
    const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : null;
    await db.execute({
      sql: `UPDATE telegram_users 
            SET status = ?, 
                approved_at = ${approvedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
                approved_by = ?
            WHERE telegram_id = ?`,
      args: [status, approvedBy, telegramId]
    });
  } catch (error) {
    console.error('Ошибка обновления статуса:', error);
  }
}

// ==================== ОБРАБОТЧИКИ СООБЩЕНИЙ ====================

// Уведомление админа о новом пользователе
async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  const userInfo = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `🕐 Запрос: ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  await sendMessageWithKeyboard(
    ADMIN_CHAT_ID,
    `🔔 <b>Новый запрос на доступ!</b>\n\n${userInfo}\n\nРазрешить доступ этому пользователю?`,
    [
      { text: '✅ Разрешить', callback_data: `approve_${userId}` },
      { text: '❌ Отклонить', callback_data: `reject_${userId}` },
      { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
    ]
  );
}

// Обработка входящих сообщений
async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  // Проверяем статус пользователя
  const user = await getUserStatus(userId);

  // Команда /start всегда доступна
  if (text === '/start') {
    if (!user) {
      // Новый пользователь - сохраняем и отправляем запрос админу
      await saveUser(userId, username, firstName, lastName, chatId);
      await sendMessage(chatId, 
        '👋 Привет! Я бот для отслеживания цен.\n\n' +
        '📝 <b>Запрос на доступ отправлен администратору.</b>\n' +
        'Ожидайте подтверждения. Это может занять некоторое время.\n\n' +
        'Как только администратор одобрит доступ, вы сможете пользоваться ботом.'
      );
      
      // Отправляем уведомление админу с кнопками
      await notifyAdminAboutNewUser(userId, username, firstName, chatId);
    } else if (user.status === 'approved') {
      await sendMessage(chatId,
        '👋 С возвращением! Вы уже в белом списке.\n\n' +
        '📋 <b>Доступные команды:</b>\n' +
        '/help - помощь\n' +
        '/status - проверить статус'
      );
    } else if (user.status === 'pending') {
      await sendMessage(chatId,
        '⏳ Ваш запрос на доступ еще рассматривается.\n' +
        'Пожалуйста, ожидайте подтверждения от администратора.'
      );
    } else if (user.status === 'rejected' || user.status === 'blocked') {
      await sendMessage(chatId,
        '⛔ <b>Доступ запрещен</b>\n\n' +
        'К сожалению, ваш запрос на доступ был отклонен.'
      );
    }
    return;
  }

  // Если пользователь не в базе или не подтвержден - игнорируем
  if (!user || user.status !== 'approved') {
    console.log(`🚫 Заблокировано сообщение от user ${userId}: ${text}`);
    return;
  }

  // Обработка команд для подтвержденных пользователей
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Доступные команды:</b>\n\n' +
      '/start - приветствие\n' +
      '/help - это сообщение\n' +
      '/status - проверить статус\n' +
      '/prices - последние изменения цен (скоро)'
    );
  } else if (text === '/status') {
    await sendMessage(chatId,
      `✅ <b>Ваш статус:</b> подтвержден\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `👤 Имя: ${firstName || 'не указано'}\n` +
      `📱 Username: @${username || 'не указан'}`
    );
  } else {
    // Любое другое сообщение
    await sendMessage(chatId,
      '❓ Неизвестная команда. Напишите /help для списка доступных команд.'
    );
  }
}

// ==================== ОБРАБОТЧИКИ CALLBACK ====================

// Обработка нажатий на инлайн-кнопки
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;
  const fromId = callbackQuery.from.id;

  // Проверяем, что админ нажимает кнопки
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallbackQuery(callbackQuery.id, '⛔ У вас нет прав для этого действия');
    return;
  }

  // Разбираем callback_data
  if (data.startsWith('approve_')) {
    const userId = data.replace('approve_', '');
    await approveUser(userId, message);
  } else if (data.startsWith('reject_')) {
    const userId = data.replace('reject_', '');
    await rejectUser(userId, message);
  } else if (data.startsWith('block_')) {
    const userId = data.replace('block_', '');
    await blockUser(userId, message);
  }

  await answerCallbackQuery(callbackQuery.id, '✅ Готово');
}

// Подтверждение пользователя
async function approveUser(userId, adminMessage) {
  // Получаем информацию о пользователе
  const user = await getUserStatus(userId);
  
  if (!user) {
    await sendMessage(ADMIN_CHAT_ID, '❌ Пользователь не найден');
    return;
  }

  // Обновляем статус в БД
  await updateUserStatus(userId, 'approved', 'admin');

  // Убираем кнопки из сообщения админа
  await editMessageReplyMarkup(adminMessage.chat.id, adminMessage.message_id);

  // Отправляем подтверждение админу
  await sendMessage(ADMIN_CHAT_ID, 
    `✅ Пользователь <code>${userId}</code> подтвержден`
  );

  // Отправляем уведомление пользователю
  await sendMessage(user.chat_id,
    '✅ <b>Доступ подтвержден!</b>\n\n' +
    'Теперь вы можете пользоваться ботом.\n' +
    'Напишите /help для списка команд.'
  );
}

// Отклонение пользователя
async function rejectUser(userId, adminMessage) {
  const user = await getUserStatus(userId);
  
  if (!user) {
    await sendMessage(ADMIN_CHAT_ID, '❌ Пользователь не найден');
    return;
  }

  await updateUserStatus(userId, 'rejected', 'admin');
  await editMessageReplyMarkup(adminMessage.chat.id, adminMessage.message_id);
  
  await sendMessage(ADMIN_CHAT_ID, `❌ Пользователь <code>${userId}</code> отклонен`);
  
  await sendMessage(user.chat_id,
    '⛔ <b>Доступ отклонен</b>\n\n' +
    'К сожалению, ваш запрос на доступ был отклонен администратором.'
  );
}

// Блокировка пользователя
async function blockUser(userId, adminMessage) {
  const user = await getUserStatus(userId);
  
  if (!user) {
    await sendMessage(ADMIN_CHAT_ID, '❌ Пользователь не найден');
    return;
  }

  await updateUserStatus(userId, 'blocked', 'admin');
  await editMessageReplyMarkup(adminMessage.chat.id, adminMessage.message_id);
  
  await sendMessage(ADMIN_CHAT_ID, `🚫 Пользователь <code>${userId}</code> заблокирован`);
  
  await sendMessage(user.chat_id,
    '🚫 <b>Вы заблокированы</b>\n\n' +
    'Доступ к боту заблокирован администратором.'
  );
}

// ==================== ПУБЛИЧНЫЕ ФУНКЦИИ ====================

// Главный обработчик входящих обновлений от Telegram
export async function handleTelegramUpdate(update) {
  try {
    // Обработка обычных сообщений
    if (update.message) {
      await handleMessage(update.message);
    }
    
    // Обработка нажатий на кнопки
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (error) {
    console.error('Ошибка обработки обновления:', error);
  }
}

// Настройка эндпоинтов для управления ботом
export function setupBotEndpoints(app, authenticateToken) {
  // Получить список пользователей Telegram
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    try {
      const result = await db.execute(`
        SELECT 
          telegram_id,
          username,
          first_name,
          last_name,
          status,
          requested_at,
          approved_at,
          approved_by
        FROM telegram_users 
        ORDER BY 
          CASE status
            WHEN 'pending' THEN 1
            WHEN 'approved' THEN 2
            ELSE 3
          END,
          requested_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Установить вебхук
  app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL обязателен' });
    }

    try {
      const webhookUrl = `${url}/api/telegram/webhook`;
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`
      );
      const data = await response.json();
      
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Информация о вебхуке
  app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
      );
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ==================== ФУНКЦИИ ДЛЯ УВЕДОМЛЕНИЙ ====================

// Отправка уведомления в основной чат
export async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.log('⚠️ Telegram не настроен, пропускаем уведомление');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Ошибка отправки в Telegram:', error);
      return false;
    }

    console.log('✅ Уведомление отправлено в Telegram');
    return true;

  } catch (error) {
    console.error('❌ Ошибка при отправке в Telegram:', error);
    return false;
  }
}

// Форматирование уведомления об изменении цены
export function formatPriceChangeNotification(product, oldPrice, newPrice, changeType = 'изменилась') {
  const change = newPrice - oldPrice;
  const changePercent = ((change / oldPrice) * 100).toFixed(1);
  const emoji = change < 0 ? '🔻' : '📈';
  const sign = change > 0 ? '+' : '';
  
  // Формируем ссылку на товар (если есть)
  const productLink = product.link 
    ? `\n<a href="${product.link}">🔗 Ссылка на товар</a>`
    : '';

  return `
<b>${emoji} Цена ${changeType}!</b>

<b>${product.name}</b>
Код товара: <code>${product.code}</code>

Старая цена: ${formatPrice(oldPrice)} руб.
Новая цена: ${formatPrice(newPrice)} руб.
Изменение: ${sign}${formatPrice(change)} руб. (${sign}${changePercent}%)${productLink}

🕐 ${new Date().toLocaleString('ru-RU')}
`;
}

// Форматирование цены
function formatPrice(price) {
  return price.toFixed(2).replace('.', ',');
}
