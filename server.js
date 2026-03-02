import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import db, { initTables } from './database.js';
import { updateAllPrices, cleanOldRecords, updatePricesForNewCode, sendWeeklyStats } from './priceUpdater.js';
import { handleTelegramUpdate, setupBotEndpoints } from './telegramBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MY_SECRET_KEY = process.env.SECRET_KEY;

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}

await initTables();

app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
    req.user = user;
    next();
  });
}

function validateProductCode(code) {
  return /^\d{1,12}$/.test(code);
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }

  if (!validateEmail(username)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    const allowed = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [username]
    });

    if (allowed.rows.length === 0) {
      return res.status(403).json({ error: 'Email не в белом списке' });
    }

    const hash = await bcrypt.hash(password, 10);
    
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [username, hash]
    });

    res.status(201).json({ message: 'Регистрация успешна' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Пользователь уже существует' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

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
});

app.post('/api/allowed-emails', async (req, res) => {
  if (req.headers['x-secret-key'] !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const { email } = req.body;
  await db.execute({
    sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
    args: [email]
  });

  res.json({ message: 'Email добавлен' });
});

app.get('/api/allowed-emails', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  try {
    const result = await db.execute('SELECT email, created_at FROM allowed_emails ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка при получении списка:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/codes', authenticateToken, async (req, res) => {
  const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
  res.json(result.rows.map(r => r.code));
});

app.post('/api/codes', authenticateToken, async (req, res) => {
  const { code } = req.body;
  
  if (!validateProductCode(code)) {
    return res.status(400).json({ error: 'Неверный формат кода' });
  }

  const count = await db.execute('SELECT COUNT(*) as c FROM product_codes');
  if (count.rows[0].c >= 5000) {
    return res.status(400).json({ error: 'Лимит 5000 товаров' });
  }

  const result = await db.execute({
    sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
    args: [code]
  });

  if (result.rows.length > 0) {
    updatePricesForNewCode(code).catch(console.error);
    res.status(201).json({ message: 'Код добавлен' });
  } else {
    res.json({ message: 'Код уже существует' });
  }
});

app.post('/api/codes/bulk', authenticateToken, async (req, res) => {
  const { codes } = req.body;

  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'Нужен массив codes' });
  }

  const results = { added: [], failed: [] };

  for (const code of codes) {
    try {
      if (!validateProductCode(code)) {
        results.failed.push({ code, reason: 'неверный формат' });
        continue;
      }

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
        updatePricesForNewCode(code).catch(console.error);
      } else {
        results.failed.push({ code, reason: 'уже существует' });
      }

    } catch (err) {
      results.failed.push({ code, reason: 'ошибка сервера' });
    }
  }

  res.json({ message: `Добавлено ${results.added.length} кодов`, results });
});

app.delete('/api/codes/:code', authenticateToken, async (req, res) => {
  const { code } = req.params;
  
  await db.execute({ sql: 'DELETE FROM price_history WHERE product_code = ?', args: [code] });
  await db.execute({ sql: 'DELETE FROM products_info WHERE code = ?', args: [code] });
  
  const result = await db.execute({ 
    sql: 'DELETE FROM product_codes WHERE code = ? RETURNING code', 
    args: [code] 
  });

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Код не найден' });
  } else {
    res.json({ message: 'Код удалён' });
  }
});

app.get('/api/products', authenticateToken, async (req, res) => {
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
});

function buildPricesMap(history, allDates) {
  const prices = {};
  allDates.forEach(date => {
    const dayRecords = history.filter(h => h.date.startsWith(date));
    if (dayRecords.length > 0) {
      const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      prices[date] = last.price;
    } else {
      const prev = history.filter(h => h.date < date)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (prev) prices[date] = prev.price;
    }
  });
  return prices;
}

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
  '30 0 * * *', '30 1 * * *', '30 6 * * *', '30 8 * * *',
  '30 9 * * *', '30 10 * * *', '30 11 * * *', '0 12 * * *',
  '30 12 * * *', '0 13 * * *', '30 13 * * *', '0 14 * * *',
  '30 14 * * *', '0 15 * * *', '30 15 * * *', '0 16 * * *',
  '30 16 * * *', '0 17 * * *', '30 17 * * *', '0 18 * * *',
  '30 18 * * *', '30 19 * * *', '0 20 * * *'
];

schedule.forEach(cronTime => {
  cron.schedule(cronTime, updateAllPrices);
});

cron.schedule('0 3 * * *', cleanOldRecords);

cron.schedule('0 5 * * 1', () => {
  console.log('📊 Запуск формирования недельной статистики');
  sendWeeklyStats();
}, {
  timezone: "Europe/Minsk"
});

setTimeout(() => {
  console.log('🚀 Запуск первого обновления после старта сервера');
  updateAllPrices();
  cleanOldRecords();
}, 10000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
