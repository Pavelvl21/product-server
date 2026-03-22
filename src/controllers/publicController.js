import db from '../../database.js';
import Logger from '../services/logger.js';

export async function getCategories(req, res, next) {
  try {
    const result = await db.execute(`
      SELECT DISTINCT category 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category
    `);
    
    res.json({ categories: result.rows.map(row => row.category) });
    
  } catch (err) {
    Logger.error('Ошибка получения категорий', err);
    next(err);
  }
}

export async function getBrands(req, res, next) {
  try {
    const result = await db.execute(`
      SELECT DISTINCT brand 
      FROM products_info 
      WHERE brand IS NOT NULL AND brand != ''
      ORDER BY brand
    `);
    
    res.json({ brands: result.rows.map(row => row.brand) });
    
  } catch (err) {
    Logger.error('Ошибка получения брендов', err);
    next(err);
  }
}

export async function updateUserCategories(req, res, next) {
  const { telegramId, categories } = req.body;
  
  if (!telegramId || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'Некорректные данные' });
  }
  
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
    
    Logger.info('Обновлены категории пользователя', { telegramId, categoriesCount: categories.length });
    res.json({ success: true });
    
  } catch (err) {
    Logger.error('Ошибка обновления категорий', err, { telegramId });
    next(err);
  }
}

export async function approveUser(req, res, next) {
  const { telegramId } = req.body;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId обязателен' });
  }
  
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET status = ? WHERE telegram_id = ?',
      args: ['approved', telegramId]
    });
    
    Logger.info('Пользователь подтвержден', { telegramId });
    res.json({ success: true });
    
  } catch (err) {
    Logger.error('Ошибка подтверждения', err, { telegramId });
    next(err);
  }
}