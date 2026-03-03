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
        text: text,
        show_alert: false
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

// ==================== ФУНКЦИЯ ДЛЯ ПОЛУЧЕНИЯ ИЗМЕНЕНИЙ ЗА СЕГОДНЯ ====================

async function getTodayPriceChanges() {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Получаем все записи за сегодня
    const result = await db.execute({
      sql: `
        SELECT 
          ph.product_code,
          ph.product_name,
          ph.price as new_price,
          ph.updated_at,
          pi.last_price as old_price,
          pi.packPrice,
          pi.monthly_payment,
          pi.no_overpayment_max_months,
          pi.link,
          pi.category,
          pi.brand
        FROM price_history ph
        JOIN products_info pi ON ph.product_code = pi.code
        WHERE DATE(ph.updated_at) = ?
        ORDER BY ph.updated_at DESC
      `,
      args: [today]
    });
    
    // Группируем по товарам и проверяем изменение цены
    const changesByProduct = {};
    
    result.rows.forEach(row => {
      const code = row.product_code;
      
      if (!changesByProduct[code]) {
        // Проверяем, изменилась ли цена
        const priceChanged = Math.abs(row.new_price - row.old_price) > 0.01;
        
        if (priceChanged) {
          changesByProduct[code] = {
            ...row,
            change: row.new_price - row.old_price,
            percent: ((row.new_price - row.old_price) / row.old_price * 100).toFixed(1)
          };
        }
      }
    });
    
    // Преобразуем в массив и сортируем по времени
    const filteredChanges = Object.values(changesByProduct)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    
    return filteredChanges;
  } catch (err) {
    console.error('Ошибка получения изменений за сегодня:', err);
    return [];
  }
}

// ==================== ФУНКЦИИ ПОКАЗА КАТЕГОРИЙ ====================

async function showAddCategories(chatId) {
  try {
    const categories = await getAllCategories();
    
    if (!categories || categories.length === 0) {
      await sendMessage(chatId, '📭 В базе пока нет категорий');
      return;
    }

    const user = await getUser(chatId);
    const selectedCategories = user?.selected_categories || [];

    // Создаем кнопки для каждой категории (только невыбранные)
    const buttons = [];
    const row = [];
    
    categories.forEach((cat, index) => {
      if (selectedCategories.includes(cat)) return;
      
      row.push({
        text: cat,
        callback_data: `add_${index}_${cat}`
      });
      
      if (row.length === 2) {
        buttons.push([...row]);
        row.length = 0;
      }
    });
    
    if (row.length > 0) {
      buttons.push(row);
    }

    // Если все категории уже выбраны
    if (buttons.length === 0 || (buttons.length === 1 && buttons[0].length === 0)) {
      buttons.length = 0;
    }

    buttons.push([{
      text: '✅ Готово',
      callback_data: 'done_adding'
    }]);

    const selectedText = selectedCategories.length > 0 
      ? `\n\n<b>Выбранные категории:</b>\n${selectedCategories.map(c => `✅ ${c}`).join('\n')}` 
      : '\n\n⚠️ Пока не выбрано ни одной категории';

    await sendMessage(chatId, 
      `📁 <b>Добавление категорий</b>\n` +
      `Нажмите на категорию, чтобы добавить её в список отслеживания.${selectedText}`, 
      { 
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    console.error('Ошибка в showAddCategories:', err);
  }
}

async function showActiveCategories(chatId) {
  try {
    const user = await getUser(chatId);
    const selectedCategories = user?.selected_categories || [];
    
    if (selectedCategories.length === 0) {
      await sendMessage(chatId, 
        '📭 У вас нет выбранных категорий.\n' +
        'Используйте /add чтобы добавить категории.'
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
      callback_data: 'back_to_add'
    }]);

    await sendMessage(chatId, 
      `📋 <b>Ваши категории (${selectedCategories.length})</b>\n` +
      `Нажмите на категорию чтобы удалить её.`, 
      { 
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    console.error('Ошибка в showActiveCategories:', err);
  }
}

// ==================== ФУНКЦИИ ФОРМАТИРОВАНИЯ ====================

function formatPrice(price) {
  return price ? price.toFixed(2).replace('.', ',') : '—';
}

function formatProductSimple(product) {
  return `• ${product.name}`;
}

function formatProductFull(product, oldPrice = null, newPrice = null, change = null, percent = null) {
  // Определяем эмодзи (цвета через HTML не работают в Telegram)
  let changeEmoji = '🆕';
  let priceChangeHtml = '';
  
  if (oldPrice && newPrice) {
    if (Math.abs(newPrice - oldPrice) < 0.01) {
      // Цена не изменилась
      priceChangeHtml = `\n💰 <b>Цена:</b> ${formatPrice(newPrice)} руб.`;
    } else {
      // Цена изменилась - используем только эмодзи для обозначения направления
      const isDecrease = newPrice < oldPrice;
      const arrow = isDecrease ? '▼' : '▲';
      const sign = isDecrease ? '' : '+';
      
      changeEmoji = isDecrease ? '🔻' : '📈';
      
      priceChangeHtml = `\n💰 <b>Было:</b> ${formatPrice(oldPrice)} руб.` +
        `\n💰 <b>Стало:</b> ${formatPrice(newPrice)} руб. ${arrow} ${sign}${change} (${sign}${percent}%)`;
    }
  } else {
    // Нет сравнения - просто показываем текущую цену
    priceChangeHtml = `\n💰 <b>Цена:</b> ${formatPrice(product.last_price)} руб.`;
  }

  return `
${changeEmoji} <b>${product.name}</b>
📋 Код: <code>${product.code}</code>${priceChangeHtml}
💳 Рассрочка: ${formatPrice(product.packPrice)} руб.
📆 Платеж: ${product.monthly_payment || '—'} руб./мес
⏱ Срок: ${product.no_overpayment_max_months || '—'} мес.
🏷 Категория: ${product.category || '—'}
🔗 <a href="https://www.21vek.by${product.link}">Ссылка на товар</a>
`;
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

    console.log(`📨 Обработка команды: ${text} от ${userId}`);

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
        await sendMessage(chatId, 
          '👋 С возвращением!\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/add - добавить категории для отслеживания\n' +
          '/list - показать выбранные категории\n' +
          '/goods - показать список товаров\n' +
          '/last - изменения цен за сегодня\n' +
          '/help - список всех команд'
        );
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
        '/add - добавить категории для отслеживания\n' +
        '/list - показать выбранные категории\n' +
        '/goods - показать список товаров (только названия)\n' +
        '/last - показать изменения цен за сегодня'
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
    } else if (text === '/add') {
      await showAddCategories(chatId);
    } else if (text === '/list') {
      await showActiveCategories(chatId);
    } else if (text === '/goods') {
      const selectedCategories = user?.selected_categories || [];
      
      console.log(`📦 /goods: выбранные категории ${JSON.stringify(selectedCategories)}`);
      
      if (selectedCategories.length === 0) {
        await sendMessage(chatId, '❌ Сначала выберите категории через /add');
        return;
      }

      let allProducts = [];
      for (const category of selectedCategories) {
        console.log(`🔍 Получение товаров для категории: ${category}`);
        const products = await getProductsByCategory(category);
        console.log(`📦 Найдено товаров в категории ${category}: ${products.length}`);
        allProducts = [...allProducts, ...products];
      }
      
      if (allProducts.length === 0) {
        await sendMessage(chatId, `📭 В выбранных категориях нет товаров`);
        return;
      }

      // Простой список товаров (только названия)
      const productList = allProducts
        .map(p => formatProductSimple(p))
        .join('\n');

      console.log(`📤 Отправка списка товаров, длина: ${productList.length}`);

      await sendMessage(chatId, 
        `📦 <b>Товары в выбранных категориях (${allProducts.length}):</b>\n\n${productList}`
      );
    } else if (text === '/last') {
      const changes = await getTodayPriceChanges();
      
      if (changes.length === 0) {
        await sendMessage(chatId, '📭 За сегодня изменений цен не было');
        return;
      }

      await sendMessage(chatId, 
        `📊 <b>Изменения цен за сегодня (${changes.length}):</b>`
      );

      // Отправляем каждое изменение отдельным сообщением
      for (const change of changes) {
        const product = {
          name: change.product_name,
          code: change.product_code,
          last_price: change.old_price,
          packPrice: change.packPrice,
          monthly_payment: change.monthly_payment,
          no_overpayment_max_months: change.no_overpayment_max_months,
          link: change.link,
          category: change.category,
          brand: change.brand
        };

        const message = formatProductFull(
          product, 
          change.old_price, 
          change.new_price,
          change.change.toFixed(2).replace('.', ','),
          change.percent.replace('.', ',')
        );

        await sendMessage(chatId, message);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      await sendMessage(chatId, '❓ Неизвестная команда. /help');
    }
  } catch (err) {
    console.error('❌ Ошибка в handleMessage:', err);
  }
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  console.log('📞 Callback получен:', query.data);
  
  try {
    const data = query.data;
    const message = query.message;
    const fromId = query.from.id;

    // ========== ДОБАВЛЕНИЕ КАТЕГОРИИ ==========
    if (data.startsWith('add_')) {
      const parts = data.split('_');
      const index = parseInt(parts[1]);
      const category = parts.slice(2).join('_');
      
      const user = await getUser(fromId);
      const selectedCategories = user?.selected_categories || [];
      
      if (!selectedCategories.includes(category)) {
        selectedCategories.push(category);
        await updateUserCategories(fromId, selectedCategories);
        await answerCallback(query.id, `✅ ${category} добавлена`);
      } else {
        await answerCallback(query.id, `⚠️ Уже добавлена`);
      }
      
      await showAddCategories(message.chat.id);
      return;
    }

    // ========== УДАЛЕНИЕ КАТЕГОРИИ ==========
    if (data.startsWith('remove_')) {
      const parts = data.split('_');
      const index = parseInt(parts[1]);
      const category = parts.slice(2).join('_');
      
      const user = await getUser(fromId);
      const selectedCategories = user?.selected_categories || [];
      
      const newCategories = selectedCategories.filter(c => c !== category);
      await updateUserCategories(fromId, newCategories);
      
      await answerCallback(query.id, `❌ ${category} удалена`);
      
      await showActiveCategories(message.chat.id);
      return;
    }

    // ========== НАЗАД К ДОБАВЛЕНИЮ ==========
    if (data === 'back_to_add') {
      await answerCallback(query.id, '🔙 Возврат');
      await showAddCategories(message.chat.id);
      return;
    }

    // ========== ГОТОВО (ЗАКРЫТЬ МЕНЮ) ==========
    if (data === 'done_adding') {
      const user = await getUser(fromId);
      const count = user?.selected_categories?.length || 0;
      
      await answerCallback(query.id, `✅ Выбрано: ${count}`);
      
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
        `✅ Выбрано категорий: ${count}\n\n` +
        `Используйте /list чтобы увидеть список\n` +
        `/goods для просмотра товаров\n` +
        `/last для просмотра изменений за сегодня.`
      );
      return;
    }

    // ========== ПРОВЕРКА ПРАВ ДЛЯ АДМИНСКИХ КНОПОК ==========
    if (fromId != ADMIN_CHAT_ID) {
      await answerCallback(query.id, '⛔ Нет прав');
      return;
    }

    // ========== АДМИНСКИЕ КНОПКИ ==========
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
          '✅ <b>Доступ подтверждён!</b>\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/add - добавить категории для отслеживания\n' +
          '/list - показать выбранные категории\n' +
          '/goods - показать список товаров\n' +
          '/last - изменения цен за сегодня\n' +
          '/help - список всех команд'
        );
        await answerCallback(query.id, '✅ Подтверждено');
      }
      return;
    }

    if (data.startsWith('reject_')) {
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
        await answerCallback(query.id, '❌ Отклонено');
      }
      return;
    }

    if (data.startsWith('block_')) {
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
  return formatProductFull(
    product, 
    oldPrice, 
    newPrice,
    change.toFixed(2).replace('.', ','),
    percent.replace('.', ',')
  );
}
