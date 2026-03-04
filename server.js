import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Joi from 'joi';
import db, { initTables } from './database.js';
import { updateAllPrices, cleanOldRecords, updatePricesForNewCode, sendWeeklyStats } from './priceUpdater.js';
import { 
  handleTelegramUpdate, 
  setupBotEndpoints,
  sendMessage as sendTelegramMessageToUser,
  sendTelegramMessage as sendTelegramMessageToAdmin,
  formatProductFull 
} from './telegramBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MY_SECRET_KEY = process.env.SECRET_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Проверка критических переменных окружения
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}
if (!MY_SECRET_KEY) {
  console.error('❌ SECRET_KEY не задан');
  process.exit(1);
}
if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('⚠️ Telegram bot не настроен полностью');
}

// Инициализация таблиц БД
await initTables();

// ==================== БЕЗОПАСНОСТЬ ====================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много попыток входа, попробуйте через час' },
  skipSuccessfulRequests: true,
});

app.use('/api/', apiLimiter);

// ==================== МИДЛВАРЫ ====================

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://price-hunter-bel.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, x-bot-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==================== ВАЛИДАЦИЯ JOI ====================

const schemas = {
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
  code: Joi.string().pattern(/^\d{1,12}$/).required(),
  codes: Joi.array().items(Joi.string().pattern(/^\d{1,12}$/)).min(1).max(100),
  telegramUrl: Joi.string().uri().required(),
  telegramId: Joi.number().integer().positive().required(),
  requestAccess: Joi.object({
    telegram_id: Joi.number().integer().positive().required(),
    username: Joi.string().allow('').optional(),
    first_name: Joi.string().allow('').optional(),
    last_name: Joi.string().allow('').optional(),
    chat_id: Joi.number().integer().positive().required(),
    selected_categories: Joi.array().items(Joi.string()).min(0).default([])
  }),
  adminCallback: Joi.object({
    callback_data: Joi.string().required(),
    message_id: Joi.number().integer().positive().required(),
    chat_id: Joi.number().integer().positive().required(),
    from_user_id: Joi.number().integer().positive().required()
  })
};

// ==================== МИДЛВАРЫ АВТОРИЗАЦИИ ====================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Токен истек' });
      }
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
}

function authenticateBot(req, res, next) {
  const botKey = req.headers['x-bot-key'];
  if (!botKey || botKey !== MY_SECRET_KEY) {
    console.warn(`⚠️ Попытка доступа бота с неверным ключом: ${req.ip}`);
    return res.status(403).json({ error: 'Доступ запрещен' });
  }
  next();
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function sanitizeInput(str) {
  return str.replace(/[<>]/g, '');
}

// ==================== ПУБЛИЧНЫЕ ЭНДПОИНТЫ ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    await schemas.email.validateAsync(username);
    await schemas.password.validateAsync(password);
    if (!validateEmail(username)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const sanitizedUsername = sanitizeInput(username);

    const allowed = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [sanitizedUsername]
    });
    if (allowed.rows.length === 0) {
      return res.status(403).json({ error: 'Email не в белом списке' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [sanitizedUsername, hash]
    });
    res.status(201).json({ message: 'Регистрация успешна' });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Некорректные данные' });
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    await schemas.email.validateAsync(username);
    await schemas.password.validateAsync(password);

    const result = await db.execute({
      sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
      args: [username]
    });
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Некорректные данные' });
    console.error('Ошибка входа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ==================== ПУБЛИЧНЫЙ ЭНДПОИНТ ДЛЯ СПИСКА КАТЕГОРИЙ ====================
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT DISTINCT category FROM products_info WHERE category IS NOT NULL AND category != ''
    `);
    const categories = result.rows.map(row => row.category).sort();
    res.json(categories);
  } catch (err) {
    console.error('Ошибка получения категорий:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ==================== ЭНДПОИНТЫ ДЛЯ АДМИНА ====================

app.post('/api/allowed-emails', authenticateBot, async (req, res) => {
  try {
    const { email } = req.body;
    await schemas.email.validateAsync(email);
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });
    res.json({ message: 'Email добавлен' });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Некорректный email' });
    console.error('Ошибка добавления email:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/allowed-emails', authenticateBot, async (req, res) => {
  try {
    const result = await db.execute('SELECT email, created_at FROM allowed_emails ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка получения списка:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================== ЭНДПОИНТЫ ДЛЯ ТЕЛЕГРАМ БОТА (НОВАЯ ЛОГИКА) ====================

// Получение статуса пользователя
app.get('/api/telegram/user-status', authenticateBot, async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id обязателен' });

    const result = await db.execute({
      sql: 'SELECT status, selected_categories FROM telegram_users WHERE telegram_id = ?',
      args: [telegram_id]
    });
    if (result.rows.length === 0) {
      return res.json(null);
    }
    const user = result.rows[0];
    let selected = [];
    try {
      selected = JSON.parse(user.selected_categories || '[]');
    } catch (e) {
      selected = [];
    }
    res.json({ status: user.status, selected_categories: selected });
  } catch (err) {
    console.error('Ошибка получения статуса пользователя:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Создание заявки на доступ
app.post('/api/telegram/request-access', authenticateBot, async (req, res) => {
  try {
    const data = req.body;
    await schemas.requestAccess.validateAsync(data);

    // Проверяем, нет ли уже пользователя
    const existing = await db.execute({
      sql: 'SELECT id FROM telegram_users WHERE telegram_id = ?',
      args: [data.telegram_id]
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }

    // Вставляем нового пользователя
    const insertResult = await db.execute({
      sql: `INSERT INTO telegram_users 
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            RETURNING id`,
      args: [
        data.telegram_id,
        data.username || '',
        data.first_name || '',
        data.last_name || '',
        data.chat_id,
        JSON.stringify(data.selected_categories)
      ]
    });
    const requestId = insertResult.rows[0].id;

    // Получаем все категории для формирования клавиатуры администратора
    const categoriesResult = await db.execute(`
      SELECT DISTINCT category FROM products_info WHERE category IS NOT NULL AND category != ''
    `);
    const allCategories = categoriesResult.rows.map(r => r.category).sort();

    // Формируем клавиатуру для админа
    const keyboard = [];
    // Строки по 2 категории
    for (let i = 0; i < allCategories.length; i += 2) {
      const row = [];
      for (let j = 0; j < 2 && i + j < allCategories.length; j++) {
        const cat = allCategories[i + j];
        const isSelected = data.selected_categories.includes(cat);
        row.push({
          text: `${isSelected ? '✅' : '⬜️'} ${cat}`,
          callback_data: `toggle:${requestId}:${cat}`
        });
      }
      keyboard.push(row);
    }
    // Кнопки действий
    keyboard.push([
      { text: '✅ Подтвердить', callback_data: `approve:${requestId}` },
      { text: '❌ Отклонить', callback_data: `reject:${requestId}` },
      { text: '🚫 Заблокировать', callback_data: `block:${requestId}` }
    ]);

    const userInfo = [
      `🆔 ID: <code>${data.telegram_id}</code>`,
      `👤 Имя: ${data.first_name || 'не указано'}`,
      `📱 Username: ${data.username ? '@' + data.username : 'не указан'}`,
      `💬 Chat ID: <code>${data.chat_id}</code>`,
      `🕐 ${new Date().toLocaleString('ru-RU')}`
    ].join('\n');

    const messageText = `🔔 <b>Новый запрос на доступ!</b>\n\n${userInfo}\n\nВыберите категории для пользователя (нажмите, чтобы переключить):`;

    // Отправляем сообщение админу через Telegram API
    await sendTelegramMessageToAdmin(messageText, {
      reply_markup: { inline_keyboard: keyboard }
    });

    res.json({ success: true, request_id: requestId });
  } catch (err) {
    console.error('Ошибка создания заявки:', err);
    if (err.isJoi) return res.status(400).json({ error: 'Некорректные данные' });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Обработка действий администратора (callback)
app.post('/api/telegram/admin/callback', authenticateBot, async (req, res) => {
  try {
    const { callback_data, message_id, chat_id, from_user_id } = req.body;
    await schemas.adminCallback.validateAsync(req.body);

    // Парсим callback_data
    const parts = callback_data.split(':');
    const action = parts[0];
    const requestId = parseInt(parts[1]);
    const category = parts[2]; // для toggle

    // Получаем заявку
    const requestResult = await db.execute({
      sql: 'SELECT * FROM telegram_users WHERE id = ?',
      args: [requestId]
    });
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    const request = requestResult.rows[0];
    let selected = JSON.parse(request.selected_categories || '[]');

    let newText = null;
    let newKeyboard = null;
    let finalAction = null; // approve/reject/block

    if (action === 'toggle') {
      // Переключаем категорию
      if (selected.includes(category)) {
        selected = selected.filter(c => c !== category);
      } else {
        selected.push(category);
      }
      // Обновляем в БД
      await db.execute({
        sql: 'UPDATE telegram_users SET selected_categories = ? WHERE id = ?',
        args: [JSON.stringify(selected), requestId]
      });

      // Перестраиваем клавиатуру
      const allCategories = await db.execute(`
        SELECT DISTINCT category FROM products_info WHERE category IS NOT NULL AND category != ''
      `);
      const categoriesList = allCategories.rows.map(r => r.category).sort();
      const keyboard = [];
      for (let i = 0; i < categoriesList.length; i += 2) {
        const row = [];
        for (let j = 0; j < 2 && i + j < categoriesList.length; j++) {
          const cat = categoriesList[i + j];
          const isSelected = selected.includes(cat);
          row.push({
            text: `${isSelected ? '✅' : '⬜️'} ${cat}`,
            callback_data: `toggle:${requestId}:${cat}`
          });
        }
        keyboard.push(row);
      }
      keyboard.push([
        { text: '✅ Подтвердить', callback_data: `approve:${requestId}` },
        { text: '❌ Отклонить', callback_data: `reject:${requestId}` },
        { text: '🚫 Заблокировать', callback_data: `block:${requestId}` }
      ]);
      newKeyboard = { inline_keyboard: keyboard };
      // Текст оставляем прежним
      newText = null; // не меняем
    } else if (['approve', 'reject', 'block'].includes(action)) {
      // Обновляем статус
      const status = action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'blocked');
      await db.execute({
        sql: 'UPDATE telegram_users SET status = ?, approved_at = CURRENT_TIMESTAMP, approved_by = ? WHERE id = ?',
        args: [status, from_user_id.toString(), requestId]
      });

      // Отправляем уведомление пользователю
      const userChatId = request.chat_id;
      if (userChatId) {
        if (action === 'approve') {
          await sendTelegramMessageToUser(userChatId, 
            '✅ <b>Доступ подтверждён!</b>\n\n' +
            '📋 <b>Команды:</b>\n' +
            '/add - добавить категории для отслеживания\n' +
            '/list - показать выбранные категории\n' +
            '/goods - показать список товаров\n' +
            '/changes - изменения цен за сегодня\n' +
            '/help - список всех команд'
          );
        } else if (action === 'reject') {
          await sendTelegramMessageToUser(userChatId, '⛔ <b>Доступ отклонён</b>');
        } else if (action === 'block') {
          await sendTelegramMessageToUser(userChatId, '🚫 <b>Вы заблокированы</b>');
        }
      }

      // Убираем клавиатуру
      newKeyboard = { inline_keyboard: [] };
      newText = `✅ Заявка обработана (${action})`;
      finalAction = action;
    }

    res.json({
      text: newText,
      reply_markup: newKeyboard
    });
  } catch (err) {
    console.error('Ошибка обработки callback админа:', err);
    if (err.isJoi) return res.status(400).json({ error: 'Некорректные данные' });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Получение категорий пользователя (для бота)
app.get('/api/telegram/user-categories', authenticateBot, async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id обязателен' });

    const result = await db.execute({
      sql: 'SELECT selected_categories FROM telegram_users WHERE telegram_id = ?',
      args: [telegram_id]
    });
    if (result.rows.length === 0) {
      return res.json([]);
    }
    let selected = [];
    try {
      selected = JSON.parse(result.rows[0].selected_categories || '[]');
    } catch (e) {
      selected = [];
    }
    res.json(selected);
  } catch (err) {
    console.error('Ошибка получения категорий пользователя:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Получение изменений цен для пользователя (с фильтром по его категориям)
app.post('/api/bot/changes', authenticateBot, async (req, res) => {
  try {
    const { telegram_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id обязателен' });

    // Получаем категории пользователя
    const userResult = await db.execute({
      sql: 'SELECT selected_categories FROM telegram_users WHERE telegram_id = ?',
      args: [telegram_id]
    });
    if (userResult.rows.length === 0) {
      return res.json([]);
    }
    let selectedCategories = [];
    try {
      selectedCategories = JSON.parse(userResult.rows[0].selected_categories || '[]');
    } catch (e) {
      selectedCategories = [];
    }
    if (selectedCategories.length === 0) {
      return res.json([]);
    }

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Получаем товары с ценами за сегодня и вчера, фильтруя по категориям
    const placeholders = selectedCategories.map(() => '?').join(',');
    const query = `
      SELECT 
        p.code,
        p.name,
        p.packPrice,
        p.monthly_payment,
        p.no_overpayment_max_months,
        p.link,
        p.category,
        p.brand,
        t.price AS today_price,
        y.price AS yesterday_price
      FROM products_info p
      LEFT JOIN price_history t ON p.code = t.product_code AND DATE(t.updated_at) = ?
      LEFT JOIN price_history y ON p.code = y.product_code AND DATE(y.updated_at) = ?
      WHERE p.category IN (${placeholders})
        AND t.price IS NOT NULL
        AND y.price IS NOT NULL
        AND ABS(t.price - y.price) > 0.01
    `;
    const args = [today, yesterday, ...selectedCategories];

    const changesResult = await db.execute({ sql: query, args });

    const changes = changesResult.rows.map(row => {
      const change = row.today_price - row.yesterday_price;
      return {
        product_code: row.code,
        product_name: row.name,
        current_price: row.today_price,
        previous_price: row.yesterday_price,
        change: change,
        percent: ((change / row.yesterday_price) * 100).toFixed(1),
        packPrice: row.packPrice,
        monthly_payment: row.monthly_payment,
        no_overpayment_max_months: row.no_overpayment_max_months,
        link: row.link,
        category: row.category,
        brand: row.brand,
        isDecrease: change < 0
      };
    });

    res.json(changes);
  } catch (err) {
    console.error('Ошибка получения изменений цен:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ==================== ОСТАЛЬНЫЕ ЗАЩИЩЕННЫЕ ЭНДПОИНТЫ (без изменений) ====================

app.get('/api/codes', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(r => r.code));
  } catch (err) {
    console.error('Ошибка получения кодов:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/codes', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    await schemas.code.validateAsync(code);

    const count = await db.execute('SELECT COUNT(*) as c FROM product_codes');
    if (count.rows[0].c >= 5000) {
      return res.status(400).json({ error: 'Лимит 5000 товаров' });
    }

    const result = await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
      args: [code]
    });

    if (result.rows.length > 0) {
      updatePricesForNewCode(code).catch(err => {
        console.error(`Ошибка обновления для кода ${code}:`, err);
      });
      res.status(201).json({ message: 'Код добавлен' });
    } else {
      res.json({ message: 'Код уже существует' });
    }
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Неверный формат кода' });
    console.error('Ошибка добавления кода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/codes/bulk', authenticateToken, async (req, res) => {
  try {
    const { codes } = req.body;
    await schemas.codes.validateAsync(codes);

    const results = { added: [], failed: [] };

    for (const code of codes) {
      try {
        const countResult = await db.execute('SELECT COUNT(*) as count FROM product_codes');
        if (countResult.rows[0].count >= 5000) {
          results.failed.push({ code, reason: 'лимит 5000 товаров' });
          continue;
        }

        const insertResult = await db.execute({
          sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
          args: [code]
        });

        if (insertResult.rows.length > 0) {
          results.added.push(code);
          updatePricesForNewCode(code).catch(err => {
            console.error(`Ошибка обновления для кода ${code}:`, err);
          });
        } else {
          results.failed.push({ code, reason: 'уже существует' });
        }
      } catch (err) {
        results.failed.push({ code, reason: 'ошибка сервера' });
      }
    }

    res.json({ message: `Добавлено ${results.added.length} кодов`, results });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Некорректный массив кодов' });
    console.error('Ошибка массового добавления:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.delete('/api/codes/:code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.params;
    await schemas.code.validateAsync(code);

    await db.execute({ sql: 'DELETE FROM price_history WHERE product_code = ?', args: [code] });
    await db.execute({ sql: 'DELETE FROM products_info WHERE code = ?', args: [code] });
    const result = await db.execute({ sql: 'DELETE FROM product_codes WHERE code = ? RETURNING code', args: [code] });

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Код не найден' });
    } else {
      res.json({ message: 'Код удалён' });
    }
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: 'Неверный формат кода' });
    console.error('Ошибка удаления кода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = await db.execute('SELECT * FROM products_info');

    const history = await db.execute(`
      SELECT product_code, price, updated_at
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY product_code, updated_at ASC
    `);

    const historyByProduct = {};
    history.rows.forEach(row => {
      if (!historyByProduct[row.product_code]) {
        historyByProduct[row.product_code] = [];
      }
      historyByProduct[row.product_code].push({
        date: row.updated_at,
        price: row.price
      });
    });

    const dates = await db.execute(`
      SELECT DISTINCT DATE(updated_at) as d
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY d ASC
    `);
    const allDates = dates.rows.map(row => row.d);

    const result = products.rows.map(p => {
      const allProductHistory = historyByProduct[p.code] || [];
      const prices = {};

      allDates.forEach(date => {
        const dayRecords = allProductHistory.filter(h => h.date.startsWith(date));
        if (dayRecords.length > 0) {
          const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          prices[date] = last.price;
        } else {
          const prev = allProductHistory.filter(h => h.date < date)
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          if (prev) prices[date] = prev.price;
        }
      });

      const filteredHistory = [];
      let lastPrice = null;
      allProductHistory.forEach(record => {
        if (lastPrice === null || Math.abs(record.price - lastPrice) > 0.01) {
          filteredHistory.push(record);
          lastPrice = record.price;
        }
      });

      return {
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category || 'Товары',
        brand: p.brand || 'Без бренда',
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        prices: prices,
        priceHistory: filteredHistory,
        currentPrice: p.last_price,
        lastUpdate: p.last_update
      };
    });

    res.json({ dates: allDates.reverse(), products: result });
  } catch (err) {
    console.error('Ошибка получения продуктов:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const productCount = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const recordCount = await db.execute('SELECT COUNT(*) as count FROM price_history');
    const oldest = await db.execute('SELECT MIN(updated_at) as min FROM price_history');
    const newest = await db.execute('SELECT MAX(updated_at) as max FROM price_history');

    const totalRecords = recordCount.rows[0].count;
    const estimatedSizeMB = (totalRecords * 0.0002).toFixed(2);

    res.json({
      total_products: productCount.rows[0].count,
      total_records: totalRecords,
      oldest_record: oldest.rows[0]?.min,
      newest_record: newest.rows[0]?.max,
      db_size_mb: estimatedSizeMB,
      storage_limit_mb: 5000,
      usage_percent: (estimatedSizeMB / 50).toFixed(1),
      product_limit: 5000,
      product_usage_percent: (productCount.rows[0].count / 5000) * 100
    });
  } catch (err) {
    console.error('Ошибка статистики:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ТЕЛЕГРАМ БОТ (эндпоинты для управления) ====================

setupBotEndpoints(app, authenticateToken);

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    await handleTelegramUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ==================== ПЛАНИРОВЩИКИ ====================

const schedule = [
  '30 0 * * *', '30 1 * * *', '30 6 * * *', '30 8 * * *',
  '30 9 * * *', '30 10 * * *', '30 11 * * *', '0 12 * * *',
  '30 12 * * *', '0 13 * * *', '30 13 * * *', '0 14 * * *',
  '30 14 * * *', '0 15 * * *', '30 15 * * *', '0 16 * * *',
  '30 16 * * *', '0 17 * * *', '30 17 * * *', '0 18 * * *',
  '30 18 * * *', '30 19 * * *', '0 20 * * *'
];

schedule.forEach(cronTime => {
  cron.schedule(cronTime, () => {
    console.log(`⏰ Запуск обновления по расписанию ${cronTime}`);
    updateAllPrices().catch(err => {
      console.error('Ошибка в запланированном обновлении:', err);
    });
  });
});

cron.schedule('0 3 * * *', () => {
  console.log('🧹 Запуск плановой очистки');
  cleanOldRecords().catch(err => {
    console.error('Ошибка при очистке:', err);
  });
});

cron.schedule('0 5 * * 1', () => {
  console.log('📊 Запуск формирования недельной статистики');
  sendWeeklyStats().catch(err => {
    console.error('Ошибка при формировании статистики:', err);
  });
}, { timezone: "Europe/Minsk" });

setTimeout(() => {
  console.log('🚀 Запуск первого обновления после старта сервера');
  updateAllPrices().catch(err => {
    console.error('Ошибка при первом обновлении:', err);
  });
  cleanOldRecords().catch(err => {
    console.error('Ошибка при первой очистке:', err);
  });
}, 10000);

// Глобальный обработчик ошибок
process.on('uncaughtException', (err) => {
  console.error('❌ Непойманное исключение:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ Необработанный rejection:', err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
