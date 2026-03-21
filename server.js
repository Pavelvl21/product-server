import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Joi from 'joi';
import db, { initTables } from './database.js'; // ← убрали updateCategoryBrandRelations
import { updateCategoryBrandRelations } from './categoryRelations.js'; // ← добавили
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
  max: 10000,
  message: { error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: 'Слишком много попыток входа, попробуйте через час' },
  skipSuccessfulRequests: true,
});

app.use('/api/', apiLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  // Разрешаем все адреса GitHub Codespaces
  const origin = req.headers.origin;
  
  // Проверяем, разрешён ли origin
  if (origin && (
    origin.includes('.app.github.dev') || // GitHub Codespaces
    origin.includes('localhost') || // Локальная разработка
    origin === 'https://price-hunter-bel.vercel.app' // Продакшен
  )) {
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

// ==================== ПУБЛИЧНЫЙ ЭНДПОИНТ ДЛЯ БРЕНДОВ ====================
app.get('/api/public/brands', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT DISTINCT brand 
      FROM products_info 
      WHERE brand IS NOT NULL AND brand != ''
      ORDER BY brand
    `);
    
    res.json({ brands: result.rows.map(row => row.brand) });
    
  } catch (err) {
    console.error('Ошибка получения брендов:', err);
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
      base_price: product.base_price,
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
    console.error('❌ Ошибка в /api/bot/products:', err);
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
      // Запускаем обновление в фоне - пользователь не ждет
      updatePricesForNewCode(code).catch(err => {
        console.error(`Ошибка обновления для кода ${code}:`, err);
      });
      res.status(201).json({ message: 'Код добавлен, данные загружаются' });
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

      return {
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category || 'Товары',
        brand: p.brand || 'Без бренда',
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        prices: prices,
        priceHistory: allProductHistory,
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

// ==================== ПОИСК ПО API 21VEK ====================
app.get('/api/external/search', authenticateToken, async (req, res) => {
  console.log('=== НАЧАЛО ЗАПРОСА /api/external/search ===');
  
  try {
    const { query } = req.query;
    console.log('1. Получен query параметр:', query);

    if (!query || query.trim() === '') {
      console.log('2. ОШИБКА: query пустой');
      return res.status(400).json({ error: 'Поисковый запрос обязателен' });
    }

    console.log('3. Пользователь авторизован, id:', req.user?.id);

    // Формируем URL для запроса к 21vek
    const searchUrl = `https://gate.21vek.by/search-composer/api/v1/search/suggest?query=${encodeURIComponent(query)}&mode=desktop`;
    console.log('4. URL для запроса к 21vek:', searchUrl);

    // Делаем запрос к API 21vek
    console.log('5. Отправка запроса к 21vek...');
    const response = await fetch(searchUrl, {
      headers: {
        "accept": "application/json",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    console.log('6. Статус ответа от 21vek:', response.status);

    if (!response.ok) {
      console.error(`❌ Ошибка ответа от 21vek: ${response.status}`);
      return res.status(502).json({ 
        error: 'Ошибка при обращении к внешнему API',
        status: response.status 
      });
    }

    // Получаем данные
    console.log('7. Чтение ответа от 21vek...');
    const data = await response.json();
    console.log('8. Получены данные от 21vek, структура:', Object.keys(data));

    // Извлекаем товары
    console.log('9. Поиск секции products в ответе...');
    const products = [];
    const productsGroup = data.data?.find(group => group.group_type === 'products');
    
    console.log('10. Найдена группа products:', !!productsGroup);
    
    if (productsGroup && productsGroup.items) {
      console.log(`11. Количество товаров в группе: ${productsGroup.items.length}`);
      
      for (const item of productsGroup.items) {
        console.log('12. Обработка товара:', item.product_id);
        
        const cleanCode = item.product_id?.replace(/\./g, '') || '';
        if (!cleanCode) continue;

        // Парсим цену
        let price = null;
        if (item.price && item.price !== 'нет на складе') {
          const priceStr = item.price.replace(/\s/g, '').replace(',', '.');
          price = parseFloat(priceStr);
        }

        // 🔥 ИСПРАВЛЕНО: db.get -> db.execute + rows[0]
        let exists = false;
        try {
          const existingResult = await db.execute({
            sql: 'SELECT code FROM products_info WHERE code = ?',
            args: [cleanCode]
          });
          exists = existingResult.rows.length > 0;
        } catch (dbErr) {
          console.error('13. Ошибка проверки БД:', dbErr);
        }

        products.push({
          code: cleanCode,
          originalCode: item.product_id,
          name: item.name || 'Без названия',
          price: price || 0,
          currentPrice: price || 0,
          url: item.url || null,
          image: item.image || null,
          exists: exists,
          fromExternal: true
        });
      }
    }

    console.log(`✅ Успешно обработано ${products.length} товаров`);
    console.log('=== КОНЕЦ ЗАПРОСА ===');
    
    res.json({ 
      query,
      products 
    });

  } catch (err) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ВНЕШНЕГО ПОИСКА:');
    console.error('Имя ошибки:', err.name);
    console.error('Сообщение:', err.message);
    console.error('Стек:', err.stack);
    console.log('=== КОНЕЦ ЗАПРОСА С ОШИБКОЙ ===');
    
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      details: err.message,
      name: err.name
    });
  }
});

// ==================== ДОБАВЛЕНИЕ ТОВАРА С ПОЛНЫМИ ДАННЫМИ ====================
app.post('/api/products/add-full', authenticateToken, async (req, res) => {
  try {
    const { 
      code, 
      name, 
      price, 
      base_price, 
      packPrice, 
      category, 
      brand, 
      monthly_payment, 
      no_overpayment_max_months, 
      link 
    } = req.body;

    console.log(`📦 Добавление товара ${code} с полными данными`);

    // 🔥 ИСПРАВЛЕНО: db.get -> db.execute + rows[0]
    const existingResult = await db.execute({
      sql: 'SELECT code FROM product_codes WHERE code = ?',
      args: [code]
    });

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Товар уже существует в базе' });
    }

    // 🔥 ИСПРАВЛЕНО: db.get -> db.execute + rows[0]
    const countResult = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const count = countResult.rows[0];
    if (count.count >= 5000) {
      return res.status(400).json({ error: 'Лимит 5000 товаров' });
    }

    // 🔥 ИСПРАВЛЕНО: db.run -> db.execute
    await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?)',
      args: [code]
    });

    // Сохраняем информацию о товаре
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    // Создаем версию в нижнем регистре
    const nameLower = name ? name.toLowerCase() : '';

    // 🔥 ИСПРАВЛЕНО: db.run -> db.execute
    await db.execute({
      sql: `
        INSERT INTO products_info (
          code, name, last_price, base_price, packPrice,
          monthly_payment, no_overpayment_max_months,
          link, category, brand, last_update,
          name_lower
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          last_price = excluded.last_price,
          base_price = excluded.base_price,
          packPrice = excluded.packPrice,
          monthly_payment = excluded.monthly_payment,
          no_overpayment_max_months = excluded.no_overpayment_max_months,
          link = excluded.link,
          category = excluded.category,
          brand = excluded.brand,
          last_update = excluded.last_update,
          name_lower = excluded.name_lower
      `,
      args: [
        code, 
        name, 
        price,
        base_price,
        packPrice,
        monthly_payment,
        no_overpayment_max_months,
        link || '', 
        category, 
        brand, 
        now,
        nameLower
      ]
    });

    // 🔥 ИСПРАВЛЕНО: db.run -> db.execute
    await db.execute({
      sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
      args: [code, name, price, now]
    });

    // ========== ОБНОВЛЯЕМ СВЯЗИ КАТЕГОРИЯ-БРЕНД ==========
    // await updateCategoryBrandRelations(category, brand);

    console.log(`✅ Товар ${code} успешно добавлен с полными данными`);
    res.json({ 
      success: true, 
      message: 'Товар успешно добавлен',
      code 
    });

  } catch (err) {
    console.error('❌ Ошибка добавления товара:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});
// ==================== ПРОВЕРКА СТАТУСА НЕСКОЛЬКИХ ТОВАРОВ ====================
app.post('/api/user/shelf/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { codes } = req.body;
    
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'Необходимо передать массив кодов' });
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

// ==================== ПОЛЬЗОВАТЕЛЬСКИЕ ЭНДПОИНТЫ ====================

// Информация о пользователе
app.get('/api/user/info', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await db.execute({
      sql: 'SELECT id, username, created_at, telegram_id FROM users WHERE id = ?',
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверяем, подтвержден ли Telegram
    const telegramVerified = user.rows[0].telegram_id !== null;
    
    res.json({
      id: user.rows[0].id,
      email: user.rows[0].username,
      created_at: user.rows[0].created_at,
      telegram_verified: telegramVerified
    });
    
  } catch (err) {
    console.error('Ошибка получения информации о пользователе:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Статистика пользователя
app.get('/api/user/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Количество товаров в мониторинге
    const monitoringCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM user_shelf WHERE user_id = ?',
      args: [userId]
    });
    
    // Количество изменений за последние 7 дней
    const changesCount = await db.execute({
      sql: `
        SELECT COUNT(DISTINCT ph.id) as count
        FROM user_shelf us
        INNER JOIN price_history ph ON us.product_code = ph.product_code
        WHERE us.user_id = ? AND ph.updated_at >= datetime('now', '-7 days')
      `,
      args: [userId]
    });
    
    res.json({
      monitoringCount: monitoringCount.rows[0].count,
      changesCount: changesCount.rows[0].count
    });
    
  } catch (err) {
    console.error('Ошибка получения статистики:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Смена пароля
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    
    // Валидация
    await schemas.password.validateAsync(newPassword);
    
    // Получаем текущий хеш пароля
    const user = await db.execute({
      sql: 'SELECT password_hash FROM users WHERE id = ?',
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверяем текущий пароль
    const valid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    
    // Хешируем новый пароль
    const hash = await bcrypt.hash(newPassword, 10);
    
    // Обновляем пароль
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [hash, userId]
    });
    
    res.json({ message: 'Пароль успешно изменен' });
    
  } catch (err) {
    if (err.isJoi) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    }
    console.error('Ошибка смены пароля:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


// ==================== ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ ПОЛКОЙ ПОЛЬЗОВАТЕЛЯ ====================

/**
 * Получить все товары на полке текущего пользователя (с фильтрацией)
 */
app.get('/api/user/shelf', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    
    console.log(`📦 Запрос полки: userId=${userId}, categories=${categories}, brands=${brands}, search=${search}`);

    let query = `
      SELECT 
        p.code,
        p.name,
        p.last_price,
        p.base_price,
        p.packPrice,
        p.monthly_payment,
        p.no_overpayment_max_months,
        p.category,
        p.brand,
        p.link,
        p.last_update,
        us.added_at as shelf_added_at
      FROM products_info p
      INNER JOIN user_shelf us ON p.code = us.product_code
      WHERE us.user_id = ${userId}
    `;
    
    if (categories.length > 0) {
      const cats = categories.map(c => `'${c}'`).join(',');
      query += ` AND p.category IN (${cats})`;
    }
    
    if (brands.length > 0) {
      const brds = brands.map(b => `'${b}'`).join(',');
      query += ` AND p.brand IN (${brds})`;
    }
    
if (search && search !== '') {
  const searchLower = search.toLowerCase();
  query += ` AND (p.name_lower LIKE '%${searchLower}%' OR p.code LIKE '%${search}%')`;
}
    
    query += ` ORDER BY us.added_at DESC`;
    
    const products = await db.execute(query);
    
    if (products.rows.length > 0) {
      const codes = products.rows.map(p => `'${p.code}'`).join(',');
      
      const history = await db.execute(`
        SELECT product_code, price, updated_at
        FROM price_history
        WHERE product_code IN (${codes})
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

      products.rows = products.rows.map(p => ({
        ...p,
        priceHistory: historyByProduct[p.code] || []
      }));
    }
    
    res.json({ products: products.rows });
    
  } catch (err) {
    console.error('❌ Ошибка полки:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Добавить товар на полку пользователя
 */
app.post('/api/user/shelf/:code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.params;
    
    console.log(`📝 Запрос на добавление: userId=${userId}, code=${code}`);
    
    // Проверяем, существует ли пользователь
    const userCheck = await db.execute({
      sql: 'SELECT id FROM users WHERE id = ?',
      args: [userId]
    });
    console.log('👤 Пользователь найден:', userCheck.rows.length > 0);
    
    // Проверяем, существует ли товар
    const productCheck = await db.execute({
      sql: 'SELECT code FROM products_info WHERE code = ?',
      args: [code]
    });
    console.log('📦 Товар найден:', productCheck.rows.length > 0);
    
    // Вставка
    const result = await db.execute({
      sql: 'INSERT OR IGNORE INTO user_shelf (user_id, product_code) VALUES (?, ?)',
      args: [userId, code]
    });
    
    console.log('💾 Результат вставки:', result);
    
    // Проверяем, добавилось ли
    const check = await db.execute({
      sql: 'SELECT * FROM user_shelf WHERE user_id = ? AND product_code = ?',
      args: [userId, code]
    });
    console.log('🔍 Проверка после вставки:', check.rows);
    
    res.json({ success: true, message: 'Товар добавлен на полку' });
  } catch (err) {
    console.error('❌ Ошибка добавления на полку:', err);
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

// ==================== ПРОВЕРКА НАЛИЧИЯ ТОВАРА В БД ПО КОДУ ====================
app.get('/api/products/check/:code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.params;
    
    console.log(`🔍 Проверка наличия товара ${code} в БД`);

    // Ищем товар в products_info
    const product = await db.execute({
      sql: 'SELECT * FROM products_info WHERE code = ?',
      args: [code]
    });

    if (product.rows.length === 0) {
      return res.json({ 
        exists: false,
        message: 'Товар не найден в базе данных'
      });
    }

    // Получаем историю цен для этого товара
    const history = await db.execute({
      sql: `
        SELECT price, updated_at
        FROM price_history
        WHERE product_code = ?
        ORDER BY updated_at ASC
      `,
      args: [code]
    });

    // Формируем ответ в том же формате, что и /api/products/paginated
    const productData = {
      code: product.rows[0].code,
      name: product.rows[0].name,
      link: product.rows[0].link,
      category: product.rows[0].category || 'Товары',
      brand: product.rows[0].brand || 'Без бренда',
      base_price: product.rows[0].base_price,
      packPrice: product.rows[0].packPrice,
      monthly_payment: product.rows[0].monthly_payment,
      no_overpayment_max_months: product.rows[0].no_overpayment_max_months,
      currentPrice: product.rows[0].last_price,
      lastUpdate: product.rows[0].last_update,
      priceHistory: history.rows.map(row => ({
        date: row.updated_at,
        price: row.price
      }))
    };

    res.json({
      exists: true,
      product: productData
    });

  } catch (err) {
    console.error('❌ Ошибка проверки товара:', err);
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      details: err.message 
    });
  }
});

// ==================== КАТАЛОГ (товары НЕ в избранном) С ПАГИНАЦИЕЙ ====================
app.get('/api/products/catalog', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 24;
    const offset = parseInt(req.query.offset) || 0;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    const sort = req.query.sort || 'default';

    console.log(`📦 Запрос каталога (не в избранном): userId=${userId}, sort=${sort}`);

    // Строим WHERE условие
    let whereConditions = [];
    let args = [];

    // Исключаем товары из избранного пользователя
    whereConditions.push(`code NOT IN (SELECT product_code FROM user_shelf WHERE user_id = ?)`);
    args.push(userId);

    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(',');
      whereConditions.push(`category IN (${placeholders})`);
      args = [...args, ...categories];
    }

    if (brands.length > 0) {
      const placeholders = brands.map(() => '?').join(',');
      whereConditions.push(`brand IN (${placeholders})`);
      args = [...args, ...brands];
    }

    if (search && search !== '') {
      const searchLower = search.toLowerCase();
      whereConditions.push(`(name_lower LIKE ? OR code LIKE ?)`);
      args.push(`%${searchLower}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Определяем сортировку
    let orderClause = '';
    if (sort === 'price_asc') {
      orderClause = 'ORDER BY CAST(last_price AS REAL) ASC, code';
    } else if (sort === 'price_desc') {
      orderClause = 'ORDER BY CAST(last_price AS REAL) DESC, code';
    } else if (sort === 'name_asc') {
      orderClause = 'ORDER BY name_lower ASC, code';
    } else if (sort === 'name_desc') {
      orderClause = 'ORDER BY name_lower DESC, code';
    } else {
      orderClause = 'ORDER BY last_update DESC, code';
    }

    // Получаем товары с пагинацией
    const products = await db.execute({
      sql: `
        SELECT * FROM products_info 
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `,
      args: [...args, limit, offset]
    });

    // Получаем общее количество
    const totalCount = await db.execute({
      sql: `SELECT COUNT(*) as count FROM products_info ${whereClause}`,
      args: args
    });

    // Если есть товары, получаем историю цен
    if (products.rows.length > 0) {
      const codes = products.rows.map(p => `'${p.code}'`).join(',');
      
      const history = await db.execute(`
        SELECT product_code, price, updated_at
        FROM price_history
        WHERE product_code IN (${codes})
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

      products.rows = products.rows.map(p => ({
        ...p,
        priceHistory: historyByProduct[p.code] || [],
        currentPrice: p.last_price ? parseFloat(p.last_price) : null
      }));
    }

    console.log(`✅ Каталог: ${products.rows.length} товаров, всего: ${totalCount.rows[0].count}`);

    res.json({
      products: products.rows,
      total: totalCount.rows[0].count,
      hasMore: offset + limit < totalCount.rows[0].count
    });

  } catch (err) {
    console.error('❌ Ошибка в /api/products/catalog:', err);
    res.status(500).json({ error: err.message });
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

// ==================== СТАТИСТИКА ДЛЯ ФИЛЬТРОВ ====================
app.get('/api/filter-stats', authenticateToken, async (req, res) => {
  try {
    // Статистика по категориям
    const categoryStats = await db.execute(`
      SELECT category, COUNT(*) as count 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY category
    `);
    
    // Статистика по брендам
    const brandStats = await db.execute(`
      SELECT brand, COUNT(*) as count 
      FROM products_info 
      WHERE brand IS NOT NULL AND brand != ''
      GROUP BY brand
      ORDER BY brand
    `);
    
    const categories = {};
    categoryStats.rows.forEach(row => {
      categories[row.category] = row.count;
    });
    
    const brands = {};
    brandStats.rows.forEach(row => {
      brands[row.brand] = row.count;
    });
    
    res.json({
      categories,
      brands
    });
    
  } catch (err) {
    console.error('Ошибка получения статистики фильтров:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


// ==================== ПОИСК ПО API 21VEK ====================
app.get('/api/external/search', authenticateToken, async (req, res) => {
  console.log('=== НАЧАЛО ЗАПРОСА /api/external/search ===');
  
  try {
    const { query } = req.query;
    console.log('1. Получен query параметр:', query);

    if (!query || query.trim() === '') {
      console.log('2. ОШИБКА: query пустой');
      return res.status(400).json({ error: 'Поисковый запрос обязателен' });
    }

    console.log('3. Пользователь авторизован, id:', req.user?.id);

    // Формируем URL для запроса к 21vek
    const searchUrl = `https://gate.21vek.by/search-composer/api/v1/search/suggest?query=${encodeURIComponent(query)}&mode=desktop`;
    console.log('4. URL для запроса к 21vek:', searchUrl);

    // Делаем запрос к API 21vek
    console.log('5. Отправка запроса к 21vek...');
    const response = await fetch(searchUrl, {
      headers: {
        "accept": "application/json",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    console.log('6. Статус ответа от 21vek:', response.status);

    if (!response.ok) {
      console.error(`❌ Ошибка ответа от 21vek: ${response.status}`);
      return res.status(502).json({ 
        error: 'Ошибка при обращении к внешнему API',
        status: response.status 
      });
    }

    // Получаем данные
    console.log('7. Чтение ответа от 21vek...');
    const data = await response.json();
    console.log('8. Получены данные от 21vek, структура:', Object.keys(data));

    // Извлекаем товары
    console.log('9. Поиск секции products в ответе...');
    const products = [];
    const productsGroup = data.data?.find(group => group.group_type === 'products');
    
    console.log('10. Найдена группа products:', !!productsGroup);
    
    if (productsGroup && productsGroup.items) {
      console.log(`11. Количество товаров в группе: ${productsGroup.items.length}`);
      
      for (const item of productsGroup.items) {
        console.log('12. Обработка товара:', item.product_id);
        
        const cleanCode = item.product_id?.replace(/\./g, '') || '';
        if (!cleanCode) continue;

        // Парсим цену
        let price = null;
        if (item.price && item.price !== 'нет на складе') {
          const priceStr = item.price.replace(/\s/g, '').replace(',', '.');
          price = parseFloat(priceStr);
        }

        // Проверяем существование в БД
        let exists = false;
        try {
          const existing = await db.get({
            sql: 'SELECT code FROM products_info WHERE code = ?',
            args: [cleanCode]
          });
          exists = !!existing;
        } catch (dbErr) {
          console.error('13. Ошибка проверки БД:', dbErr);
        }

        products.push({
          code: cleanCode,
          originalCode: item.product_id,
          name: item.name || 'Без названия',
          price: price || 0,
          currentPrice: price || 0,
          url: item.url || null,
          image: item.image || null,
          exists: exists,
          fromExternal: true
        });
      }
    }

    console.log(`✅ Успешно обработано ${products.length} товаров`);
    console.log('=== КОНЕЦ ЗАПРОСА ===');
    
    res.json({ 
      query,
      products 
    });

  } catch (err) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ВНЕШНЕГО ПОИСКА:');
    console.error('Имя ошибки:', err.name);
    console.error('Сообщение:', err.message);
    console.error('Стек:', err.stack);
    console.log('=== КОНЕЦ ЗАПРОСА С ОШИБКОЙ ===');
    
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      details: err.message,
      name: err.name
    });
  }
});

// ==================== ПОЛУЧЕНИЕ ОПЦИЙ ФИЛЬТРОВ (СВЯЗАННЫЕ) ====================
app.get('/api/filter-options', authenticateToken, async (req, res) => {
  try {
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    
    console.log('📊 filter-options запрос:', { categories, brands });
    
    const response = {
      categoryCounts: {},
      brandCounts: {}
    };

    // ===== 1. КАТЕГОРИИ (с учетом выбранных брендов) =====
    // Если выбраны бренды, показываем только категории этих брендов
    let categoryQuery = `
      SELECT category, COUNT(*) as count 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
    `;
    let categoryArgs = [];
    
    if (brands.length > 0) {
      const placeholders = brands.map(() => '?').join(',');
      categoryQuery += ` AND brand IN (${placeholders})`;
      categoryArgs = [...brands];
    }
    
    categoryQuery += ` GROUP BY category ORDER BY category`;
    
    const categoryResult = await db.execute({
      sql: categoryQuery,
      args: categoryArgs
    });
    
    categoryResult.rows.forEach(row => {
      response.categoryCounts[row.category] = row.count;
    });

    // ===== 2. БРЕНДЫ (с учетом выбранных категорий) =====
    // Если выбраны категории, показываем только бренды этих категорий
    let brandQuery = `
      SELECT brand, COUNT(*) as count 
      FROM products_info 
      WHERE brand IS NOT NULL AND brand != ''
    `;
    let brandArgs = [];
    
    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(',');
      brandQuery += ` AND category IN (${placeholders})`;
      brandArgs = [...categories];
    }
    
    brandQuery += ` GROUP BY brand ORDER BY brand`;
    
    const brandResult = await db.execute({
      sql: brandQuery,
      args: brandArgs
    });
    
    brandResult.rows.forEach(row => {
      response.brandCounts[row.brand] = row.count;
    });

    console.log('✅ filter-options ответ:', response);
    res.json(response);
    
  } catch (err) {
    console.error('❌ Ошибка получения опций фильтров:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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
  '0 16 * * *',    // 16:00 UTC = 19:00 Минск
  '0 18 * * *'   // 17:40 UTC = 20:40 Минск
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


// ==================== ВСЕ ТОВАРЫ С ПАГИНАЦИЕЙ И СОРТИРОВКОЙ ====================
app.get('/api/products/paginated', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 24;
    const offset = parseInt(req.query.offset) || 0;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    const sort = req.query.sort || 'default'; // параметр сортировки (по умолчанию без сортировки)

    console.log(`📊 Запрос всех товаров: userId=${userId}, sort=${sort}, limit=${limit}, offset=${offset}`);

    // Строим WHERE условие
    let whereConditions = [];
    let queryParams = [];

    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(',');
      whereConditions.push(`p.category IN (${placeholders})`);
      queryParams.push(...categories);
    }
    if (brands.length > 0) {
      const placeholders = brands.map(() => '?').join(',');
      whereConditions.push(`p.brand IN (${placeholders})`);
      queryParams.push(...brands);
    }
    if (search && search !== '') {
      const searchLower = search.toLowerCase();
      whereConditions.push(`(p.name_lower LIKE ? OR p.code LIKE ?)`);
      queryParams.push(`%${searchLower}%`, `%${search}%`);
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // Определяем сортировку
    let orderClause = '';
    if (sort === 'price_asc') {
      orderClause = 'ORDER BY CAST(p.last_price AS REAL) ASC, p.code';
    } else if (sort === 'price_desc') {
      orderClause = 'ORDER BY CAST(p.last_price AS REAL) DESC, p.code';
    } else if (sort === 'name_asc') {
      orderClause = 'ORDER BY p.name_lower ASC, p.code';
    } else if (sort === 'name_desc') {
      orderClause = 'ORDER BY p.name_lower DESC, p.code';
    } else {
      // По умолчанию — без сортировки (как пришло с сервера)
      orderClause = 'ORDER BY p.last_update DESC, p.code';
    }

    // Основной запрос с LEFT JOIN для флага inMonitoring
    const productsQuery = `
      SELECT 
        p.*,
        CASE WHEN us.user_id IS NOT NULL THEN 1 ELSE 0 END as inMonitoring
      FROM products_info p
      LEFT JOIN user_shelf us ON p.code = us.product_code AND us.user_id = ?
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    // Параметры: userId, фильтры, limit, offset
    const productsParams = [userId, ...queryParams, limit, offset];
    
    const products = await db.execute({
      sql: productsQuery,
      args: productsParams
    });

    // Запрос для общего количества
    let countQuery = `SELECT COUNT(*) as count FROM products_info p`;
    let countParams = [];

    if (whereConditions.length > 0) {
      countQuery += ' WHERE ' + whereConditions.join(' AND ');
      countParams = queryParams;
    }

    const totalCount = await db.execute({
      sql: countQuery,
      args: countParams
    });

    // Если товаров нет, возвращаем пустой результат
    if (products.rows.length === 0) {
      return res.json({
        products: [],
        total: totalCount.rows[0].count,
        hasMore: false
      });
    }

    // Получаем историю цен
    const codes = products.rows.map(p => `'${p.code}'`).join(',');
    const history = await db.execute(`
      SELECT product_code, price, updated_at
      FROM price_history
      WHERE product_code IN (${codes})
      ORDER BY product_code, updated_at ASC
    `);

    // Группируем историю
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

    // Формируем результат
    const result = products.rows.map(p => ({
      code: p.code,
      name: p.name,
      link: p.link,
      category: p.category || 'Товары',
      brand: p.brand || 'Без бренда',
      base_price: p.base_price,
      packPrice: p.packPrice,
      monthly_payment: p.monthly_payment,
      no_overpayment_max_months: p.no_overpayment_max_months,
      currentPrice: p.last_price ? parseFloat(p.last_price) : null,
      lastUpdate: p.last_update,
      priceHistory: historyByProduct[p.code] || [],
      inMonitoring: p.inMonitoring === 1
    }));

    res.json({
      products: result,
      total: totalCount.rows[0].count,
      hasMore: offset + limit < totalCount.rows[0].count
    });

  } catch (err) {
    console.error('❌ Ошибка в /api/products/paginated:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});


// ==================== ИЗБРАННОЕ С ПАГИНАЦИЕЙ И СОРТИРОВКОЙ ====================
app.get('/api/user/shelf/paginated', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 24;
    const offset = parseInt(req.query.offset) || 0;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    const sort = req.query.sort || 'default';

    console.log(`📦 Запрос избранного: userId=${userId}, sort=${sort}`);

    // Строим WHERE условие с параметрами
    let whereConditions = [`us.user_id = ?`];
    let queryParams = [userId];

    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(',');
      whereConditions.push(`p.category IN (${placeholders})`);
      queryParams.push(...categories);
    }
    if (brands.length > 0) {
      const placeholders = brands.map(() => '?').join(',');
      whereConditions.push(`p.brand IN (${placeholders})`);
      queryParams.push(...brands);
    }
    if (search && search !== '') {
      const searchLower = search.toLowerCase();
      whereConditions.push(`(p.name_lower LIKE ? OR p.code LIKE ?)`);
      queryParams.push(`%${searchLower}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Определяем сортировку
    let orderClause = '';
    if (sort === 'price_asc') {
      orderClause = 'ORDER BY CAST(p.last_price AS REAL) ASC, p.code';
    } else if (sort === 'price_desc') {
      orderClause = 'ORDER BY CAST(p.last_price AS REAL) DESC, p.code';
    } else if (sort === 'name_asc') {
      orderClause = 'ORDER BY p.name_lower ASC, p.code';
    } else if (sort === 'name_desc') {
      orderClause = 'ORDER BY p.name_lower DESC, p.code';
    } else {
      orderClause = 'ORDER BY us.added_at DESC, p.code';
    }

    // Основной запрос
    const productsQuery = `
      SELECT 
        p.code,
        p.name,
        p.last_price,
        p.base_price,
        p.packPrice,
        p.monthly_payment,
        p.no_overpayment_max_months,
        p.category,
        p.brand,
        p.link,
        p.last_update,
        us.added_at as shelf_added_at,
        1 as inMonitoring
      FROM products_info p
      INNER JOIN user_shelf us ON p.code = us.product_code
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    const productsParams = [...queryParams, limit, offset];
    
    const products = await db.execute({
      sql: productsQuery,
      args: productsParams
    });

    // Запрос для общего количества
    const countQuery = `
      SELECT COUNT(*) as count 
      FROM products_info p
      INNER JOIN user_shelf us ON p.code = us.product_code
      ${whereClause}
    `;
    
    const totalCount = await db.execute({
      sql: countQuery,
      args: queryParams
    });

    // Получаем историю цен
    if (products.rows.length > 0) {
      const codes = products.rows.map(p => `'${p.code}'`).join(',');
      
      const history = await db.execute(`
        SELECT product_code, price, updated_at
        FROM price_history
        WHERE product_code IN (${codes})
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

      products.rows = products.rows.map(p => ({
        ...p,
        priceHistory: historyByProduct[p.code] || [],
        currentPrice: p.last_price ? parseFloat(p.last_price) : null
      }));
    }

    res.json({
      products: products.rows,
      total: totalCount.rows[0].count,
      hasMore: offset + limit < totalCount.rows[0].count
    });

  } catch (err) {
    console.error('❌ Ошибка в /api/user/shelf/paginated:', err);
    res.status(500).json({ error: err.message });
  }
});
