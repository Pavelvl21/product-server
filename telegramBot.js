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
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        user.selected_categories = user.selected_categories 
          ? JSON.parse(user.selected_categories) 
          : [];
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

// ==================== ФУНКЦИИ ДЛЯ КАТЕГОРИЙ ====================

async function getAllCategories() {
  try {
    const result = await db.execute(`
      SELECT DISTINCT category 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category
    `);
    return result.rows.map(row => row.category);
  } catch (err) {
    console.error('Ошибка получения категорий:', err);
    return [];
  }
}

async function getProductsByCategory(category) {
  try {
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
  } catch (err) {
    console.error('Ошибка получения товаров:', err);
    return [];
  }
}

async function showCategoriesWithMultiSelect(chatId, messageId = null) {
  try {
    const categories = await getAllCategories();
    
    if (!categories || categories.length === 0) {
      await sendMessage(chatId, '📭 В базе пока нет категорий');
      return;
    }

    const user = await getUser(chatId);
    const selectedCategories = user?.selected_categories || [];

    // Создаем кнопки с кодированием кириллицы
    const buttons = categories.map(cat => {
      const isSelected = selectedCategories.includes(cat);
      const encodedCat = encodeURIComponent(cat);
      return [{
        text: isSelected ? `✅ ${cat}` : `⬜️ ${cat}`,
        callback_data: `toggle_cat_${encodedCat}`
      }];
    });

    // Добавляем кнопки управления
    buttons.unshift([{
      text: selectedCategories.length === categories.length 
        ? '🔲 Снять все' 
        : '✅ Выбрать все',
      callback_data: 'toggle_all_categories'
    }]);

    buttons.push([{
      text: '✅ Подтвердить выбор',
      callback_data: 'confirm_categories'
    }]);

    const keyboard = {
      inline_keyboard: buttons
    };

    const text = `📁 Выберите категории\n\nВыбрано: ${selectedCategories.length} из ${categories.length}\n\nНажимайте на категории для выбора, затем подтвердите.`;

    if (messageId) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text,
          reply_markup: keyboard
        })
      });
    } else {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } catch (err) {
    console.error('Ошибка в showCategoriesWithMultiSelect:', err);
  }
}

async function toggleCategory(telegramId, category) {
  const user = await getUser(telegramId);
  let selected = user?.selected_categories || [];
  
  if (selected.includes(category)) {
    selected = selected.filter(c => c !== category);
  } else {
    selected.push(category);
  }
  
  await updateUserCategories(telegramId, selected);
  return selected;
}

async function setAllCategories(telegramId, selectAll) {
  const categories = await getAllCategories();
  const selected = selectAll ? categories : [];
  await updateUserCategories(telegramId, selected);
  return selected;
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
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

    const user = await getUser(userId);

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

    if (!user || user.status !== 'approved') return;

    if (text === '/help') {
      await sendMessage(chatId,
        '📋 <b>Доступные команды:</b>\n\n' +
        '/start - приветствие\n' +
        '/help - это сообщение\n' +
        '/status - проверить статус\n' +
        '/select - выбрать категории товаров\n' +
        '/goods - показать товары из выбранных категорий'
      );
    } else if (text === '/status') {
      const categories = user.selected_categories || [];
      const categoriesInfo = categories.length > 0 
        ? `\n📁 Выбранные категории (${categories.length}):\n${categories.map(c => `• ${c}`).join('\n')}` 
        : '\n📁 Категории не выбраны';
      
      await sendMessage(chatId,
        `✅ <b>Статус:</b> подтверждён\n` +
        `🆔 ID: <code>${userId}</code>${categoriesInfo}`
      );
    } else if (text === '/select') {
      await showCategoriesWithMultiSelect(chatId);
    } else if (text === '/goods') {
      const selectedCategories = user?.selected_categories || [];
      
      if (selectedCategories.length === 0) {
        await sendMessage(chatId, '❌ Сначала выберите категории через /select');
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

      await sendMessage(chatId, `📦 Найдено товаров: ${allProducts.length}\nОтправляю список...`);

      for (const product of allProducts) {
        const formatPrice = (price) => {
          return price ? price.toFixed(2).replace('.', ',') : '—';
        };

        const fullLink = product.link 
          ? `https://www.21vek.by${product.link}` 
          : null;
          
        const productText = `
🛍 <b>${product.name}</b>

📋 Код товара: <code>${product.code}</code>
💰 <b>РЦ: ${formatPrice(product.last_price)} руб.</b>
💳 Цена в рассрочку: ${formatPrice(product.packPrice)} руб.
📆 Платеж: ${product.monthly_payment || '—'} руб./мес
⏱ Рассрочка: ${product.no_overpayment_max_months || '—'} мес.
${fullLink ? `🔗 <a href="${fullLink}">Ссылка на товар</a>` : ''}
`;
        await sendMessage(chatId, productText);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      await sendMessage(chatId, '❓ Неизвестная команда. /help');
    }
  } catch (err) {
    console.error('Ошибка в handleMessage:', err);
  }
}

// ==================== ПОЛНАЯ ФУНКЦИЯ ОБРАБОТКИ CALLBACK ====================

async function handleCallback(query) {
  console.log('📞 Callback получен:', query.data);
  
  try {
    const data = query.data;
    const message = query.message;
    const fromId = query.from.id;

    // Обработка выбора категории
    if (data.startsWith('toggle_cat_')) {
      console.log('🔍 Обработка toggle_cat');
      const encodedCat = data.replace('toggle_cat_', '');
      const category = decodeURIComponent(encodedCat);
      console.log('📁 Категория:', category);
      
      await toggleCategory(fromId, category);
      await showCategoriesWithMultiSelect(message.chat.id, message.message_id);
      await answerCallback(query.id, `🔄 Обновлено`);
      return;
    }

    // Обработка кнопки "Выбрать все / Снять все"
    if (data === 'toggle_all_categories') {
      console.log('🔍 Обработка toggle_all');
      const user = await getUser(fromId);
      const allCategories = await getAllCategories();
      const selectAll = (user?.selected_categories || []).length !== allCategories.length;
      
      await setAllCategories(fromId, selectAll);
      await showCategoriesWithMultiSelect(message.chat.id, message.message_id);
      await answerCallback(query.id, selectAll ? '✅ Все выбраны' : '🔲 Все сняты');
      return;
    }

    // Обработка подтверждения выбора
    if (data === 'confirm_categories') {
      console.log('🔍 Обработка confirm');
      const user = await getUser(fromId);
      const count = user?.selected_categories?.length || 0;
      
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
        `✅ Выбрано категорий: ${count}\n\nТеперь можете использовать /goods для просмотра товаров из выбранных категорий.`
      );
      await answerCallback(query.id, '✅ Выбор сохранён');
      return;
    }

    // Проверка прав для админских кнопок
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    // Админские кнопки
    if (data.startsWith('approve_')) {
      console.log('🔍 Обработка approve');
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
      console.log('🔍 Обработка reject');
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
      console.log('🔍 Обработка block');
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
  } catch (err) {
    console.error('❌ Ошибка в handleCallback:', err);
  }
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
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL обязателен' });

    try {
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

export function formatPriceChangeNotification(product, oldPrice, newPrice, changeType = 'изменилась') {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const emoji = change < 0 ? '🔻' : '📈';
  const sign = change > 0 ? '+' : '';
  
  const link = product.link ? `\n<a href="https://www.21vek.by${product.link}">🔗 Ссылка</a>` : '';

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
