import db from '../../database.js';
import Logger from '../services/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { schemas } from '../middleware/validation.js';

export async function getAllowedEmails(req, res, next) {
  try {
    const result = await db.execute('SELECT email, created_at FROM allowed_emails ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    Logger.error('Ошибка получения списка email', err);
    next(err);
  }
}

export async function addAllowedEmail(req, res, next) {
  try {
    const { email } = req.validatedBody;
    
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });
    
    Logger.info('Email добавлен в белый список', { email, admin: true });
    res.json({ message: 'Email добавлен' });
    
  } catch (err) {
    Logger.error('Ошибка добавления email', err, { email: req.body?.email });
    next(err);
  }
}

export async function getBotProducts(req, res, next) {
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
    
    res.json({ today, yesterday, products: result });
    
  } catch (err) {
    Logger.error('Ошибка в getBotProducts', err);
    next(err);
  }
}

export async function getStats(req, res, next) {
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
      product_limit: CONSTANTS.MAX_PRODUCTS,
      product_usage_percent: (productCount.rows[0].count / CONSTANTS.MAX_PRODUCTS) * 100
    });
    
  } catch (err) {
    Logger.error('Ошибка получения статистики', err);
    next(err);
  }
}