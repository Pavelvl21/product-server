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

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MY_SECRET_KEY = process.env.SECRET_KEY;

// Проверка обязательных переменных
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET не задан в переменных окружения!');
  process.exit(1);
}

// Инициализация БД
await initTables();

// ==================== MIDDLEWARE ====================

// JSON парсер
app.use(express.json());

// Статические файлы
app.use(express.static('public'));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function validateProductCode(code) {
  return /^\d{1,12}$/.test(code);
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ==================== ПУБЛИЧНЫЕ ЭНДПОИНТЫ ====================

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Регистрация нового пользователя
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  if (!validateEmail(username)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    // Проверяем, есть ли email в белом списке
    const allowedResult = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [username]
    });

    if (allowedResult.rows.length === 0) {
      return res.status(403).json({ error: 'Регистрация для этого email не разрешена' });
    }

    // Проверяем, не занят ли email
    const userResult = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    if (userResult.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }

    // Хешируем пароль и сохраняем
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [username, passwordHash]
    });

    res.status(201).json({ message: 'Регистрация успешна' });

  } catch (err) {
    console.error('Ошибка при регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход в систему
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  try {
    // Ищем пользователя
    const result = await db.execute({
      sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Создаем JWT токен
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ message: 'Вход выполнен успешно', token });

  } catch (err) {
    console.error('Ошибка при входе:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавление email в белый список (только по секретному ключу)
app.post('/api/allowed-emails', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const { email } = req.body;

  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });

    res.json({ message: 'Email добавлен в белый список' });

  } catch (err) {
    console.error('Ошибка при добавлении email:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение списка разрешенных email (только по секретному ключу)
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

// ==================== ЗАЩИЩЕННЫЕ ЭНДПОИНТЫ (ТРЕБУЮТ JWT) ====================

// Получение всех кодов товаров
app.get('/api/codes', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(row => row.code));
  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// Добавление нового кода товара
app.post('/api/codes', authenticateToken, async (req, res) => {
  const { code } = req.body;

  if (!validateProductCode(code)) {
    return res.status(400).json({ error: 'Код должен содержать только цифры (до 12 символов)' });
  }

  try {
    // Проверяем лимит
    const countResult = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const count = countResult.rows[0].count;

    if (count >= 5000) {
      return res.status(400).json({ error: 'Достигнут лимит в 5000 товаров' });
    }

    // Добавляем код
    const insertResult = await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
      args: [code]
    });

    if (insertResult.rows.length === 0) {
      return res.json({ message: 'Код уже существует', code });
    }

    console.log(`✅ Новый код добавлен: ${code}`);
    // Запускаем обновление для нового кода (асинхронно)
    updatePricesForNewCode(code).catch(console.error);

    res.status(201).json({ message: 'Код добавлен', code });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// Массовое добавление кодов
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

// Удаление кода товара
app.delete('/api/codes/:code', authenticateToken, async (req, res) => {
  const code = req.params.code;

  try {
    // Удаляем историю цен
    await db.execute({ sql: 'DELETE FROM price_history WHERE product_code = ?', args: [code] });
    // Удаляем информацию о товаре
    await db.execute({ sql: 'DELETE FROM products_info WHERE code = ?', args: [code] });
    
    // Удаляем сам код
    const result = await db.execute({ 
      sql: 'DELETE FROM product_codes WHERE code = ? RETURNING code', 
      args: [code] 
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Код не найден' });
    }

    res.json({ message: 'Код удалён', code });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// Получение данных о товарах с историей цен
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    // Получаем информацию о всех товарах
    const productsResult = await db.execute(`
      SELECT * FROM products_info
    `);

    // Получаем историю цен за последние 90 дней
    const historyResult = await db.execute(`
      SELECT 
        product_code,
        price,
        updated_at
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY product_code, updated_at ASC
    `);

    // Группируем историю по товарам
    const allHistoryByProduct = {};
    
    historyResult.rows.forEach(row => {
      if (!allHistoryByProduct[row.product_code]) {
        allHistoryByProduct[row.product_code] = [];
      }
      allHistoryByProduct[row.product_code].push({
        date: row.updated_at,
        price: row.price
      });
    });

    // Получаем все уникальные даты
    const datesResult = await db.execute(`
      SELECT DISTINCT DATE(updated_at) as update_date
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY update_date ASC
    `);
    const allDates = datesResult.rows.map(row => row.update_date);

    // Формируем ответ с фильтрацией дубликатов цен
    const products = productsResult.rows.map(product => {
      const allProductHistory = allHistoryByProduct[product.code] || [];
      
      // Строим словарь цен по датам
      const prices = {};
      
      allDates.forEach(date => {
        const dayRecords = allProductHistory.filter(record => 
          record.date.startsWith(date)
        );
        
        if (dayRecords.length > 0) {
          const lastRecord = dayRecords.sort((a, b) => 
            new Date(b.date) - new Date(a.date)
          )[0];
          prices[date] = lastRecord.price;
        } else {
          const previousRecords = allProductHistory.filter(record => 
            record.date < date
          ).sort((a, b) => new Date(b.date) - new Date(a.date));
          
          if (previousRecords.length > 0) {
            prices[date] = previousRecords[0].price;
          }
        }
      });

      // Фильтруем историю, убирая последовательные дубликаты цен
      const filteredHistory = [];
      let lastPrice = null;
      
      allProductHistory.forEach(record => {
        if (lastPrice === null || Math.abs(record.price - lastPrice) > 0.01) {
          filteredHistory.push(record);
          lastPrice = record.price;
        }
      });

      return {
        code: product.code,
        name: product.name,
        link: product.link,
        category: product.category || 'Товары',
        brand: product.brand || 'Без бренда',
        prices: prices,
        priceHistory: filteredHistory,
        currentPrice: product.last_price,
        lastUpdate: product.last_update
      };
    });

    res.json({ 
      dates: allDates.reverse(),
      products: products 
    });

  } catch (err) {
    console.error('Ошибка в /api/products:', err);
    res.status(500).json({ error: err.message });
  }
});

// Статистика базы данных
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

// ==================== TELEGRAM ====================

// Настройка эндпоинтов для управления ботом
setupBotEndpoints(app, authenticateToken);

// Webhook для приема обновлений от Telegram
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    console.log('📩 Получено обновление от Telegram:', update.update_id);
    
    await handleTelegramUpdate(update);
    
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка webhook:', err);
    res.sendStatus(500);
  }
});

// ==================== ПЛАНИРОВЩИК ЗАДАЧ ====================

// Расписание обновлений цен (23 раза в сутки)
const schedule = [
  '30 0 * * *',   '30 1 * * *',   '30 6 * * *',   '30 8 * * *',
  '30 9 * * *',   '30 10 * * *',  '30 11 * * *',  '0 12 * * *',
  '30 12 * * *',  '0 13 * * *',   '30 13 * * *',  '0 14 * * *',
  '30 14 * * *',  '0 15 * * *',   '30 15 * * *',  '0 16 * * *',
  '30 16 * * *',  '0 17 * * *',   '30 17 * * *',  '0 18 * * *',
  '30 18 * * *',  '30 19 * * *',  '0 20 * * *'
];

// Запускаем планировщик для каждого времени
schedule.forEach(cronTime => {
  cron.schedule(cronTime, () => {
    console.log(`⏰ Запуск обновления по расписанию ${cronTime}`);
    updateAllPrices();
  });
});

// Очистка старых записей каждую ночь в 3 часа
cron.schedule('0 3 * * *', () => {
  console.log('🧹 Запуск плановой очистки старых записей');
  cleanOldRecords();
});

// Первое обновление через 10 секунд после старта сервера
setTimeout(() => {
  console.log('🚀 Запуск первого обновления после старта сервера');
  updateAllPrices();
  cleanOldRecords();
}, 10000);

// ==================== ЗАПУСК СЕРВЕРА ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
