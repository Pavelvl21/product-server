import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db;

export async function initTables() {
  db = await open({
    filename: path.join(__dirname, 'database.sqlite'),
    driver: sqlite3.Database
  });

  // Таблица для кодов товаров
  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_codes (
      code TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица для информации о товарах
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products_info (
      code TEXT PRIMARY KEY,
      name TEXT,
      last_price REAL,
      base_price REAL,
      packPrice REAL,
      monthly_payment REAL,
      no_overpayment_max_months INTEGER,
      link TEXT,
      category TEXT,
      brand TEXT,
      last_update TIMESTAMP,
      FOREIGN KEY (code) REFERENCES product_codes(code) ON DELETE CASCADE
    )
  `);

  // Таблица для истории цен
  await db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_code TEXT,
      product_name TEXT,
      price REAL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_code) REFERENCES product_codes(code) ON DELETE CASCADE
    )
  `);

  // Таблица пользователей
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      telegram_id TEXT UNIQUE
    )
  `);

  // Таблица для белого списка email
  await db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица для полки пользователя (товары в мониторинге)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_shelf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_code TEXT,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_code) REFERENCES product_codes(code) ON DELETE CASCADE,
      UNIQUE(user_id, product_code)
    )
  `);

  // ========== НОВАЯ ТАБЛИЦА ДЛЯ СВЯЗЕЙ КАТЕГОРИЙ И БРЕНДОВ ==========
  await db.exec(`
    CREATE TABLE IF NOT EXISTS category_brand_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      products_count INTEGER DEFAULT 0,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, brand)
    )
  `);

  // Индексы для быстрого поиска
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_category_brand_category 
    ON category_brand_relations(category)
  `);
  
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_category_brand_brand 
    ON category_brand_relations(brand)
  `);

  console.log('✅ Таблицы инициализированы');
}

// Функция для обновления связей категория-бренд
export async function updateCategoryBrandRelations(category, brand) {
  if (!category || !brand || category === 'Товары' || brand === 'Без бренда') {
    return; // Игнорируем неинформативные значения
  }
  
  try {
    // Проверяем, существует ли уже такая связь
    const existing = await db.get({
      sql: 'SELECT id, products_count FROM category_brand_relations WHERE category = ? AND brand = ?',
      args: [category, brand]
    });
    
    if (existing) {
      // Обновляем счётчик
      await db.run({
        sql: `
          UPDATE category_brand_relations 
          SET products_count = products_count + 1, last_updated = CURRENT_TIMESTAMP
          WHERE category = ? AND brand = ?
        `,
        args: [category, brand]
      });
    } else {
      // Создаём новую связь
      await db.run({
        sql: `
          INSERT INTO category_brand_relations (category, brand, products_count)
          VALUES (?, ?, 1)
        `,
        args: [category, brand]
      });
    }
    console.log(`✅ Связь обновлена: ${category} - ${brand}`);
  } catch (err) {
    console.error('❌ Ошибка обновления связей:', err);
  }
}

export default db;
