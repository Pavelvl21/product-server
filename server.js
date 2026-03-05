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
import { handleTelegramUpdate, setupBotEndpoints } from './telegramBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MY_SECRET_KEY = process.env.SECRET_KEY;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}

if (!MY_SECRET_KEY) {
  console.error('❌ SECRET_KEY не задан');
  process.exit(1);
}

await initTables();

// Доверяем прокси (Koyeb)
app.set('trust proxy', 1);

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
  max: 1000,
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

const schemas = {
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
  code: Joi.string().pattern(/^\d{1,12}$/).required(),
  codes: Joi.array().items(Joi.string().pattern(/^\d{1,12}$/)).min(1).max(100),
  telegramUrl: Joi.string().uri().required()
};

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

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

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function sanitizeInput(str) {
  return str.replace(/[<>]/g, '');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ПУБЛИЧНЫЙ ЭНДПОИНТ ДЛЯ КАТЕГОРИЙ ====================

app.get('/api/public/categories', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT DISTINCT category 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category
    `);
    
    res.json({ categories: result.rows.map(row => row.category) });
    
  } catch (err) {
    console.error('Ошибка получения категорий:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ==================== ПУБЛИЧНЫЙ ЭНДПОИНТ ДЛЯ ОБНОВЛЕНИЯ КАТЕГОРИЙ ПОЛЬЗОВАТЕЛЯ ====================

app.post('/api/public/user/categories', async (req, res) => {
  const { telegramId, categories } = req.body;
  
  if (!telegramId || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'Некорректные данные' });
  }

  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка обновления категорий:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ==================== ПУБЛИЧНЫЙ ЭНДПОИНТ ДЛЯ ПОДТВЕРЖДЕНИЯ РЕГИСТРАЦИИ ====================

app.post('/api/public/user/approve', async (req, res) => {
  const { telegramId } = req.body;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId обязателен' });
  }

  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET status = ? WHERE telegram_id = ?',
      args: ['approved', telegramId]
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка подтверждения:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
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
    if (err.isJoi) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
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
    if (err.isJoi) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    console.error('Ошибка входа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

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
    if (err.isJoi) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
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

app.get('/api/bot/products', authenticateBot, async (req, res) => {
  try {
    const products = await db.execute('SELECT * FROM products_info');
    
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const todayPrices = await db.execute({
      sql: `
        SELECT ph.product_code, ph.price
        FROM price_history ph
        INNER JOIN (
          SELECT product_code, MAX(updated_at) as max_date
          FROM price_history
          WHERE DATE(updated_at) = ?
          GROUP BY product_code
        ) latest ON ph.product_code = latest.product_code AND ph.updated_at = latest.max_date
      `,
      args: [today]
    });
    
    const yesterdayPrices = await db.execute({
      sql: `
        SELECT ph.product_code, ph.price
        FROM price_history ph
        INNER JOIN (
          SELECT product_code, MAX(updated_at) as max_date
          FROM price_history
          WHERE DATE(updated_at) = ?
          GROUP BY product_code
        ) latest ON ph.product_code = latest.product_code AND ph.updated_at = latest.max_date
      `,
      args: [yesterday]
    });
    
    const todayMap = {};
    todayPrices.rows.forEach(row => {
      todayMap[row.product_code] = row.price;
    });
    
    const yesterdayMap = {};
    yesterdayPrices.rows.forEach(row => {
      yesterdayMap[row.product_code] = row.price;
    });
    
    const result = products.rows.map(product => ({
      code: product.code,
      name: product.name,
      link: product.link,
      category: product.category || 'Товары',
      brand: product.brand || 'Без бренда',
      packPrice: product.packPrice,
      monthly_payment: product.monthly_payment,
      no_overpayment_max_months: product.no_overpayment_max_months,
      priceToday: todayMap[product.code] || null,
      priceYesterday: yesterdayMap[product.code] || null,
      lastUpdate: product.last_update
    }));
    
    res.json({ 
      today,
      yesterday,
      products: result 
    });
    
  } catch (err) {
    console.error('Ошибка в /api/bot/products:', err);
    res.status(500).json({ error: err.message });
  }
});

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
    if (err.isJoi) {
      return res.status(400).json({ error: 'Неверный формат кода' });
    }
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
    if (err.isJoi) {
      return res.status(400).json({ error: 'Некорректный массив кодов' });
    }
    console.error('Ошибка массового добавления:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.delete('/api/codes/:code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.params;
    
    await schemas.code.validateAsync(code);
    
    await db.execute({ 
      sql: 'DELETE FROM price_history WHERE product_code = ?', 
      args: [code] 
    });
    
    await db.execute({ 
      sql: 'DELETE FROM products_info WHERE code = ?', 
      args: [code] 
    });
    
    const result = await db.execute({ 
      sql: 'DELETE FROM product_codes WHERE code = ? RETURNING code', 
      args: [code] 
    });

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Код не найден' });
    } else {
      res.json({ message: 'Код удалён' });
    }
    
  } catch (err) {
    if (err.isJoi) {
      return res.status(400).json({ error: 'Неверный формат кода' });
    }
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

const schedule = [
  '20 6 * * *',   // 06:20 UTC = 09:20 Минск
  '40 6 * * *',   // 06:40 UTC = 09:40 Минск
  '0 7 * * *',    // 07:00 UTC = 10:00 Минск
  '20 7 * * *',   // 07:20 UTC = 10:20 Минск
  '40 7 * * *',   // 07:40 UTC = 10:40 Минск
  '0 8 * * *',    // 08:00 UTC = 11:00 Минск
  '20 8 * * *',   // 08:20 UTC = 11:20 Минск
  '40 8 * * *',   // 08:40 UTC = 11:40 Минск
  '0 9 * * *',    // 09:00 UTC = 12:00 Минск
  '20 9 * * *',   // 09:20 UTC = 12:20 Минск
  '40 9 * * *',   // 09:40 UTC = 12:40 Минск
  '0 10 * * *',   // 10:00 UTC = 13:00 Минск
  '20 10 * * *',  // 10:20 UTC = 13:20 Минск
  '40 10 * * *',  // 10:40 UTC = 13:40 Минск
  '0 11 * * *',   // 11:00 UTC = 14:00 Минск
  '20 11 * * *',  // 11:20 UTC = 14:20 Минск
  '40 11 * * *',  // 11:40 UTC = 14:40 Минск
  '0 12 * * *',   // 12:00 UTC = 15:00 Минск
  '20 12 * * *',  // 12:20 UTC = 15:20 Минск
  '40 12 * * *',  // 12:40 UTC = 15:40 Минск
  '0 13 * * *',   // 13:00 UTC = 16:00 Минск
  '20 13 * * *',  // 13:20 UTC = 16:20 Минск
  '40 13 * * *',  // 13:40 UTC = 16:40 Минск
  '0 14 * * *',   // 14:00 UTC = 17:00 Минск
  '20 14 * * *',  // 14:20 UTC = 17:20 Минск
  '40 14 * * *',  // 14:40 UTC = 17:40 Минск
  '0 15 * * *',   // 15:00 UTC = 18:00 Минск
  '0 16 * * *'    // 16:00 UTC = 19:00 Минск
];

// ==================== ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ ПОЛКОЙ ПОЛЬЗОВАТЕЛЯ ====================

/**
 * Получить все товары на полке текущего пользователя
 */
app.get('/api/user/shelf', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Получаем товары с полки пользователя с полной информацией
    const products = await db.execute({
      sql: `
        SELECT p.*, us.added_at as shelf_added_at
        FROM products_info p
        INNER JOIN user_shelf us ON p.code = us.product_code
        WHERE us.user_id = ?
        ORDER BY us.added_at DESC
      `,
      args: [userId]
    });
    
    // Получаем историю цен для этих товаров (как в /api/products)
    if (products.rows.length === 0) {
      return res.json({ products: [] });
    }
    
    const codes = products.rows.map(p => p.code);
    const placeholders = codes.map(() => '?').join(',');
    
    const history = await db.execute({
      sql: `
        SELECT product_code, price, updated_at
        FROM price_history
        WHERE product_code IN (${placeholders})
        AND updated_at >= datetime('now', '-90 days')
        ORDER BY product_code, updated_at ASC
      `,
      args: codes
    });

    // Группируем историю по товарам
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

    // Получаем все даты для единообразного формата
    const dates = await db.execute(`
      SELECT DISTINCT DATE(updated_at) as d
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY d ASC
    `);
    
    const allDates = dates.rows.map(row => row.d);

    // Формируем результат в том же формате, что и /api/products
    const result = products.rows.map(p => {
      const productHistory = historyByProduct[p.code] || [];
      
      const prices = {};
      allDates.forEach(date => {
        const dayRecords = productHistory.filter(h => h.date.startsWith(date));
        if (dayRecords.length > 0) {
          const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          prices[date] = last.price;
        } else {
          const prev = productHistory.filter(h => h.date < date)
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          if (prev) prices[date] = prev.price;
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
        priceHistory: productHistory,
        currentPrice: p.last_price,
        lastUpdate: p.last_update,
        shelfAddedAt: p.shelf_added_at
      };
    });

    res.json({ products: result });
    
  } catch (err) {
    console.error('Ошибка получения полки пользователя:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Добавить товар на полку пользователя
 */
app.post('/api/user/shelf/:code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.params;
    
    // Проверяем, существует ли товар
    const productExists = await db.execute({
      sql: 'SELECT code FROM products_info WHERE code = ?',
      args: [code]
    });
    
    if (productExists.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не найден в базе' });
    }
    
    // Добавляем на полку (IGNORE если уже есть)
    await db.execute({
      sql: 'INSERT OR IGNORE INTO user_shelf (user_id, product_code) VALUES (?, ?)',
      args: [userId, code]
    });
    
    res.json({ 
      success: true, 
      message: 'Товар добавлен на полку' 
    });
    
  } catch (err) {
    console.error('Ошибка добавления на полку:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Удалить товар с полки пользователя
 */
app.delete('/api/user/shelf/:code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.params;
    
    const result = await db.execute({
      sql: 'DELETE FROM user_shelf WHERE user_id = ? AND product_code = ? RETURNING id',
      args: [userId, code]
    });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не найден на полке' });
    }
    
    res.json({ 
      success: true, 
      message: 'Товар удален с полки' 
    });
    
  } catch (err) {
    console.error('Ошибка удаления с полки:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Проверить статус нескольких товаров для текущего пользователя
 */
app.post('/api/user/shelf/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { codes } = req.body;
    
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'Необходимо передать массив кодов' });
    }
    
    if (codes.length > 100) {
      return res.status(400).json({ error: 'Слишком много кодов (максимум 100)' });
    }
    
    const placeholders = codes.map(() => '?').join(',');
    const result = await db.execute({
      sql: `
        SELECT product_code 
        FROM user_shelf 
        WHERE user_id = ? AND product_code IN (${placeholders})
      `,
      args: [userId, ...codes]
    });
    
    const shelfCodes = new Set(result.rows.map(r => r.product_code));
    const status = {};
    codes.forEach(code => {
      status[code] = shelfCodes.has(code);
    });
    
    res.json(status);
    
  } catch (err) {
    console.error('Ошибка проверки статуса:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

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

cron.schedule('10 6 * * 1', () => {  // 9:10 по Минску (6:10 UTC)
  console.log('📊 Запуск формирования недельной статистики');
  sendWeeklyStats().catch(err => {
    console.error('Ошибка при формировании статистики:', err);
  });
});

setTimeout(() => {
  console.log('🚀 Запуск первого обновления после старта сервера');
  updateAllPrices().catch(err => {
    console.error('Ошибка при первом обновлении:', err);
  });
  cleanOldRecords().catch(err => {
    console.error('Ошибка при первой очистке:', err);
  });
}, 10000);

process.on('uncaughtException', (err) => {
  console.error('❌ Непойманное исключение:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Необработанный rejection:', err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
