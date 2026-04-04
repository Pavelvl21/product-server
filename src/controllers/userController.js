import db from '../../database.js';
import bcrypt from 'bcrypt';
import { SafeQueryBuilder, getOrderByClause } from '../services/queryBuilder.js';
import Logger from '../services/logger.js';
import { CONSTANTS } from '../config/constants.js';
import { schemas } from '../middleware/validation.js';

export async function getUserInfo(req, res, next) {
  try {
    const userId = req.user.id;
    
    const user = await db.execute({
      sql: 'SELECT id, username, created_at, telegram_id FROM users WHERE id = ?',
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const telegramVerified = user.rows[0].telegram_id !== null;
    
    res.json({
      id: user.rows[0].id,
      email: user.rows[0].username,
      created_at: user.rows[0].created_at,
      telegram_verified: telegramVerified
    });
    
  } catch (err) {
    Logger.error('Ошибка получения информации о пользователе', err, { userId: req.user?.id });
    next(err);
  }
}

export async function getUserStats(req, res, next) {
  try {
    const userId = req.user.id;
    
    const monitoringCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM user_shelf WHERE user_id = ?',
      args: [userId]
    });
    
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
    Logger.error('Ошибка получения статистики', err, { userId: req.user?.id });
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.validatedBody;
    
    const user = await db.execute({
      sql: 'SELECT password_hash, temp_password, temp_password_expires FROM users WHERE id = ?',
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверка текущего пароля (обычный или временный)
    let isValid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    
    if (!isValid && user.rows[0].temp_password) {
      isValid = currentPassword === user.rows[0].temp_password;
      if (isValid) {
        const expiresAt = new Date(user.rows[0].temp_password_expires);
        const now = new Date();
        if (now > expiresAt) {
          return res.status(401).json({ error: 'Временный пароль истек' });
        }
      }
    }
    
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    
    // Проверка, что новый пароль не содержит email
    const username = req.user.username;
    const emailLocalPart = username.split('@')[0].toLowerCase();
    const newPasswordLower = newPassword.toLowerCase();
    
    if (newPasswordLower.includes(emailLocalPart) || newPasswordLower.includes(username.toLowerCase())) {
      return res.status(400).json({ 
        error: 'Пароль не должен содержать email или имя пользователя' 
      });
    }
    
    const isSameAsOld = await bcrypt.compare(newPassword, user.rows[0].password_hash);
    if (isSameAsOld) {
      return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
    }
    
    const hash = await bcrypt.hash(newPassword, 10);
    
    // Обновляем пароль И удаляем временный
    await db.execute({
      sql: `UPDATE users 
            SET password_hash = ?, 
                temp_password = NULL, 
                temp_password_expires = NULL 
            WHERE id = ?`,
      args: [hash, userId]
    });
    
    Logger.info('Пароль изменен', { userId });
    res.json({ message: 'Пароль успешно изменен' });
    
  } catch (err) {
    Logger.error('Ошибка смены пароля', err, { userId: req.user?.id });
    next(err);
  }
}

export async function getShelf(req, res, next) {
  try {
    const userId = req.user.id;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    
    const builder = new SafeQueryBuilder();
    
    builder.addInCondition('p.category', categories);
    builder.addInCondition('p.brand', brands);
    builder.addLikeCondition('p.name_lower', search);
    builder.addLikeCondition('p.code', search);
    
    const { whereClause, params } = builder.buildWhere();
    
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
      WHERE us.user_id = ?
    `;
    
    const queryParams = [userId];
    
    if (whereClause) {
      query += ` AND ${whereClause.replace('WHERE ', '')}`;
      queryParams.push(...params);
    }
    
    query += ` ORDER BY us.added_at DESC`;
    
    const products = await db.execute({
      sql: query,
      args: queryParams
    });
    
    if (products.rows.length > 0) {
      const codes = products.rows.map(p => p.code);
      const placeholders = codes.map(() => '?').join(',');
      
      const history = await db.execute({
        sql: `
          SELECT product_code, price, updated_at
          FROM price_history
          WHERE product_code IN (${placeholders})
          ORDER BY product_code, updated_at ASC
        `,
        args: codes
      });
      
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
        exists: true,
        priceHistory: historyByProduct[p.code] || []
      }));
    }
    
    res.json({ products: products.rows });
    
  } catch (err) {
    Logger.error('Ошибка получения полки', err, { userId: req.user?.id });
    next(err);
  }
}

export async function getShelfPaginated(req, res, next) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || CONSTANTS.DEFAULT_PAGE_SIZE;
    const offset = parseInt(req.query.offset) || 0;
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    const search = req.query.search;
    const sort = req.query.sort || 'default';
    const { from, to, code } = req.query;
    
    let startDate, endDate;
    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      endDate = new Date().toISOString().split('T')[0];
      startDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }
    
    const builder = new SafeQueryBuilder();
    
    builder.addCondition('us.user_id = ?', userId);
    builder.addInCondition('p.category', categories);
    builder.addInCondition('p.brand', brands);
    
    if (code) {
      builder.addCondition('p.code = ?', code);
    }
    
    if (search && search.trim() !== '') {
      const searchLower = search.toLowerCase().trim();
      builder.addCondition(`(p.name_lower LIKE ? OR p.code LIKE ?)`, `%${searchLower}%`, `%${search}%`);
    }
    
    const { whereClause, params } = builder.buildWhere();
    
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
    
    const products = await db.execute({
      sql: `
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
      `,
      args: [...params, limit, offset]
    });
    
    const countResult = await db.execute({
      sql: `
        SELECT COUNT(*) as count 
        FROM products_info p
        INNER JOIN user_shelf us ON p.code = us.product_code
        ${whereClause}
      `,
      args: params
    });
    
    const totalProductsCount = await db.execute('SELECT COUNT(*) as count FROM products_info');
    
    if (products.rows.length > 0) {
      const codes = products.rows.map(p => p.code);
      const placeholders = codes.map(() => '?').join(',');
      
      const history = await db.execute({
        sql: `
          SELECT product_code, price, updated_at
          FROM price_history
          WHERE product_code IN (${placeholders})
            AND DATE(updated_at) BETWEEN ? AND ?
          ORDER BY product_code, updated_at ASC
        `,
        args: [...codes, startDate, endDate]
      });
      
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
      
      const datesResult = await db.execute({
        sql: `
          SELECT DISTINCT DATE(updated_at) as d
          FROM price_history
          WHERE DATE(updated_at) BETWEEN ? AND ?
          ORDER BY d ASC
        `,
        args: [startDate, endDate]
      });
      const allDates = datesResult.rows.map(row => row.d);
      
      products.rows = products.rows.map(p => {
        const productHistory = historyByProduct[p.code] || [];
        const prices = {};
        
        allDates.forEach(date => {
          const dayRecords = productHistory.filter(h => h.date.startsWith(date));
          if (dayRecords.length > 0) {
            const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
            prices[date] = last.price;
          } else {
            const prev = productHistory.filter(h => h.date < date)
              .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
            if (prev) prices[date] = prev.price;
          }
        });
        
        return {
          ...p,
          priceHistory: productHistory,
          prices: prices,
          currentPrice: p.last_price ? parseFloat(p.last_price) : null,
          exists: true
        };
      });
    }
    
    res.json({
      products: products.rows,
      total: countResult.rows[0].count,
      totalProducts: totalProductsCount.rows[0].count,
      from: startDate,
      to: endDate,
      hasMore: offset + limit < countResult.rows[0].count
    });
    
  } catch (err) {
    Logger.error('Ошибка в getShelfPaginated', err, { userId: req.user?.id });
    next(err);
  }
}
export async function addToShelf(req, res, next) {
  try {
    const userId = req.user.id;
    const { code } = req.params;
    
    const productCheck = await db.execute({
      sql: 'SELECT code FROM products_info WHERE code = ?',
      args: [code]
    });
    
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не найден' });
    }
    
    await db.execute({
      sql: 'INSERT OR IGNORE INTO user_shelf (user_id, product_code) VALUES (?, ?)',
      args: [userId, code]
    });
    
    Logger.info('Товар добавлен на полку', { userId, code });
    res.json({ success: true, message: 'Товар добавлен на полку' });
    
  } catch (err) {
    Logger.error('Ошибка добавления на полку', err, { userId: req.user?.id, code: req.params?.code });
    next(err);
  }
}

export async function removeFromShelf(req, res, next) {
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
    
    Logger.info('Товар удален с полки', { userId, code });
    res.json({ success: true, message: 'Товар удален с полки' });
    
  } catch (err) {
    Logger.error('Ошибка удаления с полки', err, { userId: req.user?.id, code: req.params?.code });
    next(err);
  }
}

export async function checkShelfStatus(req, res, next) {
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
    Logger.error('Ошибка проверки статуса', err, { userId: req.user?.id });
    next(err);
  }
}

export async function getFilterStats(req, res, next) {
  try {
    const categoryStats = await db.execute(`
      SELECT category, COUNT(*) as count 
      FROM products_info 
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY category
    `);
    
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
    
    res.json({ categories, brands });
    
  } catch (err) {
    Logger.error('Ошибка получения статистики фильтров', err);
    next(err);
  }
}

export async function getFilterOptions(req, res, next) {
  try {
    const categories = req.query.categories ? 
      (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
    const brands = req.query.brands ? 
      (Array.isArray(req.query.brands) ? req.query.brands : [req.query.brands]) : [];
    
    const response = {
      categoryCounts: {},
      brandCounts: {}
    };
    
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
    
    res.json(response);
    
  } catch (err) {
    Logger.error('Ошибка получения опций фильтров', err);
    next(err);
  }
}
