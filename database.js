import { createClient } from '@libsql/client';

// ==================== ПОДКЛЮЧЕНИЕ К БАЗЕ ====================
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌ Turso credentials missing');
  process.exit(1);
}

const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

// ==================== ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ====================
export async function initTables() {
  try {
    // Пользователи с паролями
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Белый список email для регистрации
    await db.execute(`
      CREATE TABLE IF NOT EXISTS allowed_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Коды отслеживаемых товаров
    await db.execute(`
      CREATE TABLE IF NOT EXISTS product_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // История цен
    await db.execute(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Актуальная информация о товарах
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
    
    // Пользователи Telegram для модерации
    await db.execute(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        status TEXT DEFAULT 'pending',
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        approved_by TEXT,
        chat_id INTEGER
      )
    `);
    
    console.log('✅ Все таблицы инициализированы');
  } catch (err) {
    console.error('❌ Ошибка инициализации таблиц:', err);
  }
}

export default db;
