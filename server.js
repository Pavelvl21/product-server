// server.js - Полный код с умной историей и временем изменений
import express from 'express';
import { createClient } from '@libsql/client';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static('public'));

// --- Переменные окружения ---
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const MY_SECRET_KEY = process.env.SECRET_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET не задан в переменных окружения!');
  process.exit(1);
}

// --- Подключение к Turso ---
let db;
try {
  db = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN,
  });
  console.log('✅ Turso клиент создан');
} catch (err) {
  console.error('❌ Ошибка создания клиента Turso:', err.message);
  process.exit(1);
}

// --- Валидация кода товара ---
function validateProductCode(code) {
  return /^\d{1,12}$/.test(code);
}

// --- Валидация email ---
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// --- Инициализация таблиц ---
async function initTables() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS allowed_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS product_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS products_info (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_price REAL NOT NULL,
        last_update DATETIME DEFAULT CURRENT_TIMESTAMP,
        link TEXT,
        category TEXT,
        brand TEXT
      )
    `);
    
    console.log('✅ Все таблицы инициализированы');
  } catch (err) {
    console.error('❌ Ошибка инициализации таблиц:', err);
  }
}

initTables();

// --- Middleware для проверки JWT ---
const authenticateToken = (req, res, next) => {
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
};

// ==================== ПУБЛИЧНЫЕ ЭНДПОИНТЫ ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  if (!validateEmail(username)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    const allowedResult = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [username]
    });

    if (allowedResult.rows.length === 0) {
      return res.status(403).json({ error: 'Регистрация для этого email не разрешена' });
    }

    const userResult = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    if (userResult.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }

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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  try {
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

// ==================== ЗАЩИЩЕННЫЕ ЭНДПОИНТЫ ====================

app.get('/api/codes', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(row => row.code));
  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/codes', authenticateToken, async (req, res) => {
  const { code } = req.body;

  if (!validateProductCode(code)) {
    return res.status(400).json({ error: 'Код должен содержать только цифры (до 12 символов)' });
  }

  try {
    const countResult = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const count = countResult.rows[0].count;

    if (count >= 5000) {
      return res.status(400).json({ error: 'Достигнут лимит в 5000 товаров' });
    }

    const insertResult = await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
      args: [code]
    });

    if (insertResult.rows.length === 0) {
      return res.json({ message: 'Код уже существует', code });
    }

    console.log(`✅ Новый код добавлен: ${code}`);
    updatePricesForNewCode(code).catch(console.error);

    res.status(201).json({ message: 'Код добавлен', code });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
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
  const code = req.params.code;

  try {
    await db.execute({ sql: 'DELETE FROM price_history WHERE product_code = ?', args: [code] });
    await db.execute({ sql: 'DELETE FROM products_info WHERE code = ?', args: [code] });
    
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

// ==================== ОСНОВНОЙ ЭНДПОИНТ С УМНОЙ ИСТОРИЕЙ ====================

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    // Получаем все записи из price_history за последние 90 дней
    const historyResult = await db.execute(`
      SELECT 
        p.code,
        p.name,
        p.link,
        p.category,
        p.brand,
        ph.price,
        ph.updated_at
      FROM products_info p
      LEFT JOIN price_history ph ON p.code = ph.product_code
        AND ph.updated_at >= datetime('now', '-90 days')
      ORDER BY p.name, ph.updated_at DESC
    `);

    // Получаем последнюю цену для каждого товара
    const latestPricesResult = await db.execute(`
      SELECT 
        product_code,
        price,
        updated_at
      FROM price_history
      WHERE (product_code, updated_at) IN (
        SELECT product_code, MAX(updated_at)
        FROM price_history
        WHERE updated_at >= datetime('now', '-90 days')
        GROUP BY product_code
      )
    `);

    const latestPrices = new Map();
    latestPricesResult.rows.forEach(row => {
      latestPrices.set(row.product_code, {
        price: row.price,
        updated_at: row.updated_at
      });
    });

    // Группируем по товарам
    const products = {};
    historyResult.rows.forEach(row => {
      if (!products[row.code]) {
        products[row.code] = {
          code: row.code,
          name: row.name,
          link: row.link,
          category: row.category,
          brand: row.brand,
          prices: {},
          priceHistory: []
        };
      }
      
      if (row.updated_at) {
        const date = row.updated_at.split(' ')[0];
        const time = row.updated_at.split(' ')[1];
        
        if (!products[row.code].prices[date] || 
            products[row.code].prices[date].time < time) {
          products[row.code].prices[date] = {
            price: row.price,
            time: time,
            fullDate: row.updated_at
          };
        }
        
        products[row.code].priceHistory.push({
          date: row.updated_at,
          price: row.price
        });
      }
    });

    // Форматируем для фронтенда
    const productsArray = Object.values(products).map(p => {
      const formattedPrices = {};
      Object.entries(p.prices).forEach(([date, value]) => {
        formattedPrices[date] = value.price;
      });
      
      return {
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category,
        brand: p.brand,
        prices: formattedPrices,
        priceHistory: p.priceHistory.sort((a, b) => 
          new Date(b.date) - new Date(a.date)
        ),
        currentPrice: latestPrices.get(p.code)?.price || null,
        lastUpdate: latestPrices.get(p.code)?.updated_at || null
      };
    });

    const datesResult = await db.execute(`
      SELECT DISTINCT DATE(updated_at) as update_date
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY update_date DESC
    `);
    const dateColumns = datesResult.rows.map(row => row.update_date);

    res.json({ 
      dates: dateColumns, 
      products: productsArray 
    });

  } catch (err) {
    console.error('Ошибка в /api/products:', err);
    res.status(500).json({ error: err.message });
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

// ==================== ФУНКЦИИ ОБНОВЛЕНИЯ ЦЕН ====================

// --- ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ВСТАВКИ ---
async function insertPriceRecord(code, name, price, timestamp) {
  await db.execute({
    sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
    args: [code, name, price, timestamp.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

// --- УМНАЯ ФУНКЦИЯ СОХРАНЕНИЯ ДАННЫХ ТОВАРА ---
async function saveProductData(product, timestamp) {
  const code = product.code.toString();
  const price = parseFloat(product.packPrice || product.price);
  const now = timestamp || new Date();
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

  let category = 'Товары';
  if (product.categories && product.categories.length > 0) {
    category = product.categories[product.categories.length - 1].name;
  }
  const brand = product.producerName || 'Без бренда';

  // Получаем последнюю запись для этого товара (вообще последнюю, не только за сегодня)
  const lastRecord = await db.execute({
    sql: `SELECT price, updated_at FROM price_history 
          WHERE product_code = ? 
          ORDER BY updated_at DESC LIMIT 1`,
    args: [code]
  });

  // Получаем запись за сегодня (если есть)
  const todayRecord = await db.execute({
    sql: `SELECT id, price FROM price_history 
          WHERE product_code = ? AND DATE(updated_at) = ? 
          ORDER BY updated_at DESC LIMIT 1`,
    args: [code, today]
  });

  const lastPrice = lastRecord.rows[0]?.price;
  const lastDate = lastRecord.rows[0]?.updated_at;
  const lastDateDay = lastDate ? lastDate.split(' ')[0] : null;

  // Логика принятия решения
  if (todayRecord.rows.length === 0) {
    // Нет записи за сегодня - сохраняем всегда
    console.log(`📝 Первая запись за ${today} для ${code}`);
    await insertPriceRecord(code, product.name, price, now);
  } else {
    // Запись за сегодня уже есть
    if (Math.abs(price - lastPrice) > 0.01) {
      // Цена изменилась (относительно последней записи вообще)
      console.log(`🔄 Цена изменилась для ${code}: ${lastPrice} → ${price}`);
      await insertPriceRecord(code, product.name, price, now);
    } else {
      // Цена не изменилась - проверяем, была ли сегодня уже запись
      if (lastDateDay !== today) {
        // Последняя запись была не сегодня, но цена не изменилась
        // Пропускаем, так как сегодня уже есть запись с этой ценой
        console.log(`⏭️ Цена не изменилась, пропускаем (уже есть запись за сегодня)`);
      } else {
        // Последняя запись сегодня и цена не изменилась
        console.log(`⏭️ Цена не изменилась, пропускаем (последняя запись сегодня)`);
      }
    }
  }

  // Обновляем products_info всегда
  await db.execute({
    sql: `
      INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        last_price = excluded.last_price,
        link = excluded.link,
        category = excluded.category,
        brand = excluded.brand,
        last_update = excluded.last_update
    `,
    args: [code, product.name, price, product.link || '', category, brand, now.toISOString().slice(0, 19).replace('T', ' ')]
  });
}
  await db.execute({
    sql: `
      INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        last_price = excluded.last_price,
        link = excluded.link,
        category = excluded.category,
        brand = excluded.brand,
        last_update = excluded.last_update
    `,
    args: [code, product.name, price, product.link || '', category, brand, now.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

// --- Обновление для нового кода ---
async function updatePricesForNewCode(code) {
  console.log(`🔄 Начинаем обновление для нового кода: ${code}`);

  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: [parseInt(code)],
        isAdult: false,
        limit: 1
      }),
      method: "POST"
    });

    if (!response.ok) {
      console.error(`❌ Ошибка HTTP для кода ${code}:`, response.status);
      return;
    }

    const data = await response.json();
    const product = data.data.productCards[0];

    if (!product) {
      console.log(`📭 Нет данных для кода ${code} от API`);
      return;
    }

    const now = new Date();
    await saveProductData(product, now);
    console.log(`✅ Данные для нового кода ${code} загружены: ${product.name} - ${product.packPrice || product.price} руб.`);

  } catch (error) {
    console.error(`❌ Ошибка при загрузке данных для кода ${code}:`, error);
  }
}

// --- Обновление всех цен с пакетной отправкой ---
async function updateAllPrices() {
  const startTime = Date.now();
  console.log('🚀 Начинаем ускоренное обновление цен:', new Date().toLocaleString());

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    console.log(`📦 Всего кодов в базе: ${allCodes.length}`);

    const BATCH_SIZE = 100;
    const CONCURRENT_LIMIT = 3;
    
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`📊 Будет обработано ${batches.length} пачек по ${BATCH_SIZE} кодов`);

    let processedBatches = 0;
    let totalUpdated = 0;
    let totalErrors = 0;

    const processBatch = async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      const batchStartTime = new Date();
      
      console.log(`📤 [Пачка ${batchNum}/${batches.length}] Отправка ${batch.length} кодов`);

      try {
        const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
          },
          body: JSON.stringify({
            ids: batch.map(code => parseInt(code)),
            isAdult: false,
            limit: BATCH_SIZE
          }),
          method: "POST"
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const products = data.data?.productCards || [];

        console.log(`📥 [Пачка ${batchNum}] Получено ${products.length} товаров`);

        if (products.length === 0) {
          console.log(`⚠️ [Пачка ${batchNum}] Нет данных от API`);
          return 0;
        }

        for (const product of products) {
          try {
            await saveProductData(product, batchStartTime);
          } catch (saveError) {
            console.error(`❌ Ошибка сохранения товара ${product.code}:`, saveError.message);
          }
        }

        console.log(`✅ [Пачка ${batchNum}] Успешно обработана`);
        return products.length;

      } catch (error) {
        console.error(`❌ [Пачка ${batchNum}] Ошибка:`, error.message);
        totalErrors++;
        return 0;
      }
    };

    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      console.log(`\n🔄 Запуск группы из ${currentBatches.length} параллельных пачек`);
      
      const results = await Promise.all(
        currentBatches.map((batch, idx) => processBatch(batch, i + idx))
      );
      
      totalUpdated += results.reduce((sum, count) => sum + (count || 0), 0);
      processedBatches += currentBatches.length;
      
      console.log(`📊 Прогресс: ${processedBatches}/${batches.length} пачек`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n🎉 Обновление завершено!');
    console.log(`⏱️  Время выполнения: ${totalTime} сек`);

  } catch (error) {
    console.error('❌ Глобальная ошибка при обновлении цен:', error);
  }
}

// --- Очистка старых записей ---
async function cleanOldRecords() {
  console.log('🧹 Очистка записей старше 90 дней...');
  try {
    const result = await db.execute({
      sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
      args: []
    });
    console.log(`✅ Удалено ${result.rowsAffected} старых записей`);
  } catch (err) {
    console.error('❌ Ошибка при очистке:', err);
  }
}

// ==================== ПЛАНИРОВЩИКИ ====================

const schedule = [
  '30 0 * * *',   '30 1 * * *',   '30 6 * * *',   '30 8 * * *',
  '30 9 * * *',   '30 10 * * *',  '30 11 * * *',  '0 12 * * *',
  '30 12 * * *',  '0 13 * * *',   '30 13 * * *',  '0 14 * * *',
  '30 14 * * *',  '0 15 * * *',   '30 15 * * *',  '0 16 * * *',
  '30 16 * * *',  '0 17 * * *',   '30 17 * * *',  '0 18 * * *',
  '30 18 * * *',  '30 19 * * *',  '0 20 * * *'
];

schedule.forEach(cronTime => {
  cron.schedule(cronTime, () => {
    console.log(`⏰ Запуск обновления по расписанию ${cronTime}`);
    updateAllPrices();
  });
});

cron.schedule('0 3 * * *', () => {
  console.log('🧹 Запуск плановой очистки старых записей');
  cleanOldRecords();
});

setTimeout(() => {
  console.log('🚀 Запуск первого обновления после старта сервера');
  updateAllPrices();
  cleanOldRecords();
}, 10000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
