import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import db, { initTables } from './database.js';
import { updateAllPrices, cleanOldRecords, updatePricesForNewCode } from './priceUpdater.js';
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

// Инициализация БД
await initTables();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth middleware
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
    req.user = user;
    next();
  });
}

// ==================== ПУБЛИЧНЫЕ ЭНДПОИНТЫ ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }

  try {
    // Проверка в белом списке
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

// Логин
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

// Добавление email в белый список (только по секретному ключу)
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

// ==================== ЗАЩИЩЕННЫЕ ЭНДПОИНТЫ ====================

// Получить все коды
app.get('/api/codes', authenticateToken, async (req, res) => {
  const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
  res.json(result.rows.map(r => r.code));
});

// Добавить код
app.post('/api/codes', authenticateToken, async (req, res) => {
  const { code } = req.body;
  
  if (!/^\d{1,12}$/.test(code)) {
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
    // Асинхронно загружаем данные
    updatePricesForNewCode(code).catch(console.error);
    res.status(201).json({ message: 'Код добавлен' });
  } else {
    res.json({ message: 'Код уже существует' });
  }
});

// Удалить код
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

// Получить товары с историей цен
app.get('/api/products', authenticateToken, async (req, res) => {
  const products = await db.execute('SELECT * FROM products_info');
  
  const history = await db.execute(`
    SELECT product_code, price, updated_at
    FROM price_history
    WHERE updated_at >= datetime('now', '-90 days')
    ORDER BY product_code, updated_at ASC
  `);

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

  // Получаем все даты для таблицы
  const dates = await db.execute(`
    SELECT DISTINCT DATE(updated_at) as d
    FROM price_history
    WHERE updated_at >= datetime('now', '-90 days')
    ORDER BY d ASC
  `);

  const allDates = dates.rows.map(row => row.d);

  // Формируем ответ
  const result = products.rows.map(p => ({
    code: p.code,
    name: p.name,
    link: p.link,
    category: p.category || 'Товары',
    brand: p.brand || 'Без бренда',
    currentPrice: p.last_price,
    lastUpdate: p.last_update,
    priceHistory: historyByProduct[p.code] || [],
    prices: buildPricesMap(historyByProduct[p.code] || [], allDates)
  }));

  res.json({ dates: allDates.reverse(), products: result });
});

function buildPricesMap(history, allDates) {
  const prices = {};
  allDates.forEach(date => {
    const dayRecords = history.filter(h => h.date.startsWith(date));
    if (dayRecords.length > 0) {
      // Берём последнюю запись за день
      const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      prices[date] = last.price;
    } else {
      // Берём предыдущую известную цену
      const prev = history.filter(h => h.date < date)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (prev) prices[date] = prev.price;
    }
  });
  return prices;
}

// Статистика
app.get('/api/stats', authenticateToken, async (req, res) => {
  const productCount = await db.execute('SELECT COUNT(*) as c FROM product_codes');
  const recordCount = await db.execute('SELECT COUNT(*) as c FROM price_history');
  
  res.json({
    total_products: productCount.rows[0].c,
    total_records: recordCount.rows[0].c,
    product_limit: 5000,
    storage_limit_mb: 5000
  });
});

// ==================== TELEGRAM ====================
setupBotEndpoints(app, authenticateToken);

// Webhook для Telegram
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    await handleTelegramUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ==================== ПЛАНИРОВЩИК ====================

// Расписание обновлений
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

// Очистка в 3 ночи
cron.schedule('0 3 * * *', cleanOldRecords);

// Первое обновление через 10 сек после старта
setTimeout(() => {
  console.log('🚀 Первое обновление...');
  updateAllPrices();
  cleanOldRecords();
}, 10000);

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
