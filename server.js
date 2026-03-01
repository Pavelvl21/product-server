// server.js - Полностью переписан под Turso (работает из коробки!)
import express from 'express';
import { createClient } from '@libsql/client';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// --- РАЗРЕШЕНИЕ CORS ДЛЯ ВАШЕГО САЙТА ---
app.use((req, res, next) => {
  // Разрешаем запросы только с вашего домена на Vercel
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  // Разрешаем нужные методы
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  // Разрешаем нужные заголовки (включая ваш секретный ключ)
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-secret-key');
  
  // Если это предварительный OPTIONS-запрос (preflight), отвечаем успешно
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});
const PORT = process.env.PORT || 3000;

// --- Настройка middleware ---
app.use(express.json());
app.use(express.static('public'));

// --- ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (их добавим позже на Koyeb) ---
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const MY_SECRET_KEY = process.env.SECRET_KEY;

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

// --- Проверка подключения ---
async function testConnection() {
  try {
    await db.execute('SELECT 1');
    console.log('✅ Подключено к Turso');
    
    // Создаем таблицы при первом запуске (на всякий случай)
    await initTables();
  } catch (err) {
    console.error('❌ Ошибка подключения к Turso:', err.message);
  }
}

// --- Инициализация таблиц (если вдруг не создали вручную) ---
async function initTables() {
  try {
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
    
    console.log('✅ Таблицы инициализированы');
  } catch (err) {
    console.error('❌ Ошибка инициализации таблиц:', err);
  }
}

testConnection();

// --- ВАЛИДАЦИЯ КОДА ---
function validateProductCode(code) {
  return /^\d{1,12}$/.test(code);
}

// --- API: ПОЛУЧИТЬ ВСЕ КОДЫ ---
app.get('/api/codes', async (req, res) => {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(row => row.code));
  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ДОБАВИТЬ КОД ---
app.post('/api/codes', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

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
    
    // Запускаем немедленное обновление
    updatePricesForNewCode(code).catch(console.error);

    res.status(201).json({ message: 'Код добавлен', code });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});
// --- API: МАССОВОЕ ДОБАВЛЕНИЕ КОДОВ (только с ключом) ---
app.post('/api/codes/bulk', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const { codes } = req.body;

  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'Нужен массив codes' });
  }

  const results = {
    added: [],
    failed: []
  };

  for (const code of codes) {
    try {
      // Проверяем валидность
      if (!validateProductCode(code)) {
        results.failed.push({ code, reason: 'неверный формат' });
        continue;
      }

      // Проверяем лимит
      const countResult = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM product_codes',
        args: []
      });
      
      if (countResult.rows[0].count >= 5000) {
        results.failed.push({ code, reason: 'лимит 5000 товаров' });
        continue;
      }

      // Добавляем код
      const insertResult = await db.execute({
        sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
        args: [code]
      });

      if (insertResult.rows.length > 0) {
        results.added.push(code);
        // Запускаем обновление для этого кода (не ждём)
        updatePricesForNewCode(code).catch(console.error);
      } else {
        results.failed.push({ code, reason: 'уже существует' });
      }

    } catch (err) {
      console.error(`Ошибка при добавлении кода ${code}:`, err);
      results.failed.push({ code, reason: 'ошибка сервера' });
    }
  }

  res.json({
    message: `Добавлено ${results.added.length} кодов`,
    results
  });
});
// --- API: УДАЛИТЬ КОД ---
app.delete('/api/codes/:code', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

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

// --- API: ПОЛУЧИТЬ ДАННЫЕ ДЛЯ ТАБЛИЦЫ ---
app.get('/api/products', async (req, res) => {
  try {
    const datesResult = await db.execute(`
      SELECT DISTINCT DATE(updated_at) as update_date
      FROM price_history
      WHERE updated_at >= datetime('now', '-90 days')
      ORDER BY update_date DESC
    `);

    const dateColumns = datesResult.rows.map(row => row.update_date);

    const productsResult = await db.execute(`
      SELECT
        p.code,
        p.name,
        p.link,
        p.category,
        p.brand,
        ph.price,
        DATE(ph.updated_at) as update_date
      FROM products_info p
      LEFT JOIN price_history ph ON p.code = ph.product_code
        AND ph.updated_at >= datetime('now', '-90 days')
      ORDER BY p.name
    `);

    const products = {};
    productsResult.rows.forEach(row => {
      if (!products[row.code]) {
        products[row.code] = {
          code: row.code,
          name: row.name,
          link: row.link,
          category: row.category,
          brand: row.brand,
          prices: {}
        };
      }
      if (row.update_date) {
        products[row.code].prices[row.update_date] = row.price;
      }
    });

    res.json({ dates: dateColumns, products: Object.values(products) });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: СТАТИСТИКА ---
app.get('/api/stats', async (req, res) => {
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

// --- ФУНКЦИЯ ОЧИСТКИ СТАРЫХ ЗАПИСЕЙ ---
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

// --- ФУНКЦИЯ ОБНОВЛЕНИЯ ВСЕХ ЦЕН ---
async function updateAllPrices() {
  console.log('🔄 Начинаем обновление цен:', new Date().toLocaleString());

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    
    if (codesResult.rows.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    const productCodes = codesResult.rows.map(row => row.code);
    console.log(`📦 Найдено кодов: ${productCodes.length}`);

    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: productCodes.map(code => parseInt(code)),
        isAdult: false,
        limit: 100
      }),
      method: "POST"
    });

    if (!response.ok) {
      console.error('❌ Ошибка HTTP:', response.status);
      return;
    }

    const data = await response.json();
    const products = data.data.productCards;

    if (!products || products.length === 0) {
      console.log('📭 Нет данных от API');
      return;
    }

    console.log(`📥 Получены данные для ${products.length} товаров`);

    for (const product of products) {
      const code = product.code.toString();
      const price = parseFloat(product.packPrice || product.price);

      let category = 'Товары';
      if (product.categories && product.categories.length > 0) {
        category = product.categories[product.categories.length - 1].name;
      }
      const brand = product.producerName || 'Без бренда';

      await db.execute({
        sql: 'INSERT INTO price_history (product_code, product_name, price) VALUES (?, ?, ?)',
        args: [code, product.name, price]
      });

      await db.execute({
        sql: `
          INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(code) DO UPDATE SET
            name = excluded.name,
            last_price = excluded.last_price,
            link = excluded.link,
            category = excluded.category,
            brand = excluded.brand,
            last_update = CURRENT_TIMESTAMP
        `,
        args: [code, product.name, price, product.link || '', category, brand]
      });
    }

    console.log('✅ Обновление завершено');

  } catch (error) {
    console.error('❌ Ошибка при обновлении цен:', error);
  }
}

// --- ФУНКЦИЯ ОБНОВЛЕНИЯ ДЛЯ НОВОГО КОДА ---
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

    const price = parseFloat(product.packPrice || product.price);

    let category = 'Товары';
    if (product.categories && product.categories.length > 0) {
      category = product.categories[product.categories.length - 1].name;
    }
    const brand = product.producerName || 'Без бренда';

    await db.execute({
      sql: 'INSERT INTO price_history (product_code, product_name, price) VALUES (?, ?, ?)',
      args: [code, product.name, price]
    });

    await db.execute({
      sql: `
        INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          last_price = excluded.last_price,
          link = excluded.link,
          category = excluded.category,
          brand = excluded.brand,
          last_update = CURRENT_TIMESTAMP
      `,
      args: [code, product.name, price, product.link || '', category, brand]
    });

    console.log(`✅ Данные для нового кода ${code} загружены: ${product.name} - ${price} руб.`);

  } catch (error) {
    console.error(`❌ Ошибка при загрузке данных для кода ${code}:`, error);
  }
}

// --- ПЛАНИРОВЩИКИ ---
cron.schedule('0 3 * * *', () => {
  console.log('⏰ Запуск плановой очистки');
  cleanOldRecords();
});

cron.schedule('0 * * * *', () => {
  console.log('⏰ Запуск планового обновления цен');
  updateAllPrices();
});

// --- ВЕБ-ИНТЕРФЕЙС ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  
  setTimeout(() => {
    console.log('⏰ Запуск первого обновления');
    updateAllPrices();
    cleanOldRecords();
  }, 10000);
});
