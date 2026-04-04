import db from '../../database.js';
import { CONSTANTS } from '../config/constants.js';
import { SafeQueryBuilder, getOrderByClause } from '../services/queryBuilder.js';
import Logger from '../services/logger.js';
import { updatePricesForNewCode } from '../../priceUpdater.js';
import { schemas } from '../middleware/validation.js';

export async function getProducts(req, res, next) {
  try {
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
      
      return {
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category || 'Товары',
        brand: p.brand || 'Без бренда',
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        prices: prices,
        priceHistory: allProductHistory,
        currentPrice: p.last_price,
        lastUpdate: p.last_update
      };
    });
    
    res.json({ dates: allDates.reverse(), products: result });
    
  } catch (err) {
    Logger.error('Ошибка получения продуктов', err);
    next(err);
  }
}
export async function getCatalogProducts(req, res, next) {
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
    
    const builder = new SafeQueryBuilder();
    
    builder.addInCondition('p.category', categories);
    builder.addInCondition('p.brand', brands);
    if (search && search.trim() !== '') {
      const searchLower = search.toLowerCase().trim();
      builder.addCondition(`(p.name_lower LIKE ? OR p.code LIKE ?)`, `%${searchLower}%`, `%${search}%`);
    }
    
    // Ключевое отличие: исключаем товары, которые уже в избранном пользователя
    builder.addCondition(`p.code NOT IN (SELECT product_code FROM user_shelf WHERE user_id = ?)`, userId);
    
    const { whereClause, params } = builder.buildWhere();
    const orderClause = getOrderByClause(sort);
    
    const products = await db.execute({
      sql: `
        SELECT 
          p.*,
          0 as inMonitoring
        FROM products_info p
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `,
      args: [...params, limit, offset]
    });
    
    // Общее количество для пагинации (без учёта LIMIT)
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM products_info p ${whereClause}`,
      args: params
    });
    
    // Общее количество товаров в системе (для Header)
    const totalProductsCount = await db.execute('SELECT COUNT(*) as count FROM products_info');
    
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
        priceHistory: historyByProduct[p.code] || [],
        currentPrice: p.last_price ? parseFloat(p.last_price) : null
      }));
    }
    
    res.json({
      products: products.rows,
      total: countResult.rows[0].count,
      totalProducts: totalProductsCount.rows[0].count,
      hasMore: offset + limit < countResult.rows[0].count
    });
    
  } catch (err) {
    Logger.error('Ошибка в getCatalogProducts', err);
    next(err);
  }
}

export async function getPaginatedProducts(req, res, next) {
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
    
    const builder = new SafeQueryBuilder();
    
    builder.addInCondition('p.category', categories);
    builder.addInCondition('p.brand', brands);
    if (search && search.trim() !== '') {
      const searchLower = search.toLowerCase().trim();
      builder.addCondition(`(p.name_lower LIKE ? OR p.code LIKE ?)`, `%${searchLower}%`, `%${search}%`);
    }
    
    const { whereClause, params } = builder.buildWhere();
    const orderClause = getOrderByClause(sort);
    
    const allParams = [userId, ...params];
    
    const products = await db.execute({
      sql: `
        SELECT 
          p.*,
          CASE WHEN us.user_id IS NOT NULL THEN 1 ELSE 0 END as inMonitoring
        FROM products_info p
        LEFT JOIN user_shelf us ON p.code = us.product_code AND us.user_id = ?
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `,
      args: [...allParams, limit, offset]
    });
    
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM products_info p ${whereClause}`,
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
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category || 'Товары',
        brand: p.brand || 'Без бренда',
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        currentPrice: p.last_price ? parseFloat(p.last_price) : null,
        lastUpdate: p.last_update,
        priceHistory: historyByProduct[p.code] || [],
        inMonitoring: p.inMonitoring === 1,
        exists: true
      }));
    }
    
    res.json({
      products: products.rows,
      total: countResult.rows[0].count,
      totalProducts: totalProductsCount.rows[0].count,
      hasMore: offset + limit < countResult.rows[0].count
    });
    
  } catch (err) {
    Logger.error('Ошибка в getPaginatedProducts', err);
    next(err);
  }
}

export async function getCodes(req, res, next) {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(r => r.code));
  } catch (err) {
    Logger.error('Ошибка получения кодов', err);
    next(err);
  }
}

export async function addCode(req, res, next) {
  try {
    const { code } = req.validatedBody;
    
    // Атомарная проверка лимита и вставка
    const result = await db.execute({
      sql: `
        INSERT INTO product_codes (code)
        SELECT ? WHERE (SELECT COUNT(*) FROM product_codes) < ?
        ON CONFLICT(code) DO NOTHING
        RETURNING code
      `,
      args: [code, CONSTANTS.MAX_PRODUCTS]
    });
    
    if (result.rows.length === 0) {
      const exists = await db.execute({
        sql: 'SELECT code FROM product_codes WHERE code = ?',
        args: [code]
      });
      
      if (exists.rows.length > 0) {
        return res.json({ message: 'Код уже существует' });
      }
      return res.status(400).json({ error: `Лимит ${CONSTANTS.MAX_PRODUCTS} товаров` });
    }
    
    // Запускаем обновление в фоне
    updatePricesForNewCode(code).catch(err => {
      Logger.error('Ошибка обновления для нового кода', err, { code });
    });
    
    Logger.info('Код добавлен', { code });
    res.status(201).json({ message: 'Код добавлен, данные загружаются' });
    
  } catch (err) {
    Logger.error('Ошибка добавления кода', err, { code: req.body?.code });
    next(err);
  }
}

export async function bulkAddCodes(req, res, next) {
  try {
    const { codes } = req.validatedBody;
    const results = { added: [], failed: [] };
    
    for (const code of codes) {
      try {
        const result = await db.execute({
          sql: `
            INSERT INTO product_codes (code)
            SELECT ? WHERE (SELECT COUNT(*) FROM product_codes) < ?
            ON CONFLICT(code) DO NOTHING
            RETURNING code
          `,
          args: [code, CONSTANTS.MAX_PRODUCTS]
        });
        
        if (result.rows.length > 0) {
          results.added.push(code);
          updatePricesForNewCode(code).catch(err => {
            Logger.error('Ошибка обновления для кода', err, { code });
          });
        } else {
          const exists = await db.execute({
            sql: 'SELECT code FROM product_codes WHERE code = ?',
            args: [code]
          });
          
          if (exists.rows.length > 0) {
            results.failed.push({ code, reason: 'уже существует' });
          } else {
            results.failed.push({ code, reason: 'лимит 5000 товаров' });
          }
        }
      } catch (err) {
        Logger.error('Ошибка при массовом добавлении кода', err, { code });
        results.failed.push({ code, reason: 'ошибка сервера' });
      }
    }
    
    Logger.info('Массовое добавление кодов', { added: results.added.length, failed: results.failed.length });
    res.json({ message: `Добавлено ${results.added.length} кодов`, results });
    
  } catch (err) {
    Logger.error('Ошибка массового добавления кодов', err);
    next(err);
  }
}

export async function deleteCode(req, res, next) {
  try {
    const { code } = req.params;
    
    await db.execute({ 
      sql: 'DELETE FROM price_history WHERE product_code = ?', 
      args: [code] 
    });
    
    await db.execute({ 
      sql: 'DELETE FROM products_info WHERE code = ?', 
      args: [code] 
    });
    
    const result = await db.execute({ 
      sql: 'DELETE FROM product_codes WHERE code = ? RETURNING code', 
      args: [code] 
    });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Код не найден' });
    }
    
    Logger.info('Код удален', { code });
    res.json({ message: 'Код удалён' });
    
  } catch (err) {
    Logger.error('Ошибка удаления кода', err, { code: req.params?.code });
    next(err);
  }
}

export async function checkProduct(req, res, next) {
  try {
    const { code } = req.params;
    
    const product = await db.execute({
      sql: 'SELECT * FROM products_info WHERE code = ?',
      args: [code]
    });
    
    if (product.rows.length === 0) {
      return res.json({ exists: false, message: 'Товар не найден в базе данных' });
    }
    
    const history = await db.execute({
      sql: `
        SELECT price, updated_at
        FROM price_history
        WHERE product_code = ?
        ORDER BY updated_at ASC
      `,
      args: [code]
    });
    
    res.json({
      exists: true,
      product: {
        code: product.rows[0].code,
        name: product.rows[0].name,
        link: product.rows[0].link,
        category: product.rows[0].category || 'Товары',
        brand: product.rows[0].brand || 'Без бренда',
        base_price: product.rows[0].base_price,
        packPrice: product.rows[0].packPrice,
        monthly_payment: product.rows[0].monthly_payment,
        no_overpayment_max_months: product.rows[0].no_overpayment_max_months,
        currentPrice: product.rows[0].last_price,
        lastUpdate: product.rows[0].last_update,
        priceHistory: history.rows.map(row => ({
          date: row.updated_at,
          price: row.price
        }))
      }
    });
    
  } catch (err) {
    Logger.error('Ошибка проверки товара', err, { code: req.params?.code });
    next(err);
  }
}

export async function addFullProduct(req, res, next) {
  try {
    const { 
      code, name, price, base_price, packPrice, 
      category, brand, monthly_payment, no_overpayment_max_months, link 
    } = req.body;
    
    // Атомарная проверка существования и лимита
    const existingResult = await db.execute({
      sql: 'SELECT code FROM product_codes WHERE code = ?',
      args: [code]
    });
    
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Товар уже существует в базе' });
    }
    
    const countResult = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM product_codes'
    });
    
    if (countResult.rows[0].count >= CONSTANTS.MAX_PRODUCTS) {
      return res.status(400).json({ error: `Лимит ${CONSTANTS.MAX_PRODUCTS} товаров` });
    }
    
    // Транзакция
    await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?)',
      args: [code]
    });
    
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const nameLower = name ? name.toLowerCase() : '';
    
    await db.execute({
      sql: `
        INSERT INTO products_info (
          code, name, last_price, base_price, packPrice,
          monthly_payment, no_overpayment_max_months,
          link, category, brand, last_update, name_lower
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          last_price = excluded.last_price,
          base_price = excluded.base_price,
          packPrice = excluded.packPrice,
          monthly_payment = excluded.monthly_payment,
          no_overpayment_max_months = excluded.no_overpayment_max_months,
          link = excluded.link,
          category = excluded.category,
          brand = excluded.brand,
          last_update = excluded.last_update,
          name_lower = excluded.name_lower
      `,
      args: [
        code, name, price, base_price, packPrice,
        monthly_payment, no_overpayment_max_months,
        link || '', category, brand, now, nameLower
      ]
    });
    
    await db.execute({
      sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
      args: [code, name, price, now]
    });
    
    Logger.info('Товар добавлен с полными данными', { code, name });
    res.json({ success: true, message: 'Товар успешно добавлен', code });
    
  } catch (err) {
    Logger.error('Ошибка добавления товара', err, { code: req.body?.code });
    next(err);
  }
}
export async function fetchAndAddProduct(req, res, next) {
  try {
    console.log('🚀 [fetchAndAddProduct] НАЧАЛО');
    console.log('📦 [fetchAndAddProduct] req.body:', JSON.stringify(req.body, null, 2));
    console.log('👤 [fetchAndAddProduct] userId:', req.user?.id);
    
    const { code } = req.body;
    
    console.log('🔍 [fetchAndAddProduct] code =', code, 'тип:', typeof code);
    
    if (!code) {
      console.log('❌ [fetchAndAddProduct] Код не передан');
      return res.status(400).json({ error: 'Код товара обязателен' });
    }
    
    // 1. Проверяем, есть ли товар уже в БД
    console.log('🔍 [fetchAndAddProduct] Проверяем существование товара в БД...');
    const existingProduct = await db.execute({
      sql: 'SELECT code FROM products_info WHERE code = ?',
      args: [code]
    });
    
    console.log('📊 [fetchAndAddProduct] existingProduct.rows.length =', existingProduct.rows.length);
    
    if (existingProduct.rows.length > 0) {
      console.log('✅ [fetchAndAddProduct] Товар уже есть в БД, возвращаем данные');
      return await returnProductData(code, res);
    }
    
    // 2. Получаем данные с 21vek
    console.log('🌐 [fetchAndAddProduct] Запрашиваем данные с 21vek...');
    const productData = await fetchFrom21vek(code);
    
    console.log('📦 [fetchAndAddProduct] productData =', productData ? 'получен' : 'null');
    if (productData) {
      console.log('📦 [fetchAndAddProduct] productData.id =', productData.id);
      console.log('📦 [fetchAndAddProduct] productData.name =', productData.name);
    }
    
    if (!productData) {
      console.log('❌ [fetchAndAddProduct] Товар не найден на 21vek');
      return res.status(404).json({ error: 'Товар не найден на 21vek.by' });
    }
    
    // 3. Добавляем товар в БД
    console.log('💾 [fetchAndAddProduct] Добавляем товар в БД...');
    await addProductToDatabase(productData, code);
    console.log('✅ [fetchAndAddProduct] Товар добавлен в БД');
    
    // 4. Возвращаем данные
    await returnProductData(code, res);
    
  } catch (err) {
    console.error('❌ [fetchAndAddProduct] ОШИБКА:', err);
    console.error('❌ [fetchAndAddProduct] Стек:', err.stack);
    Logger.error('Ошибка fetch-and-add', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', details: err.message });
  }
}

// Вспомогательная функция: получить данные с 21vek
async function fetchFrom21vek(code) {
  try {
    console.log('🌐 [fetchFrom21vek] НАЧАЛО, code =', code, 'тип:', typeof code);
    
    const requestBody = {
      ids: [parseInt(code)],
      isAdult: false,
      limit: 100
    };
    console.log('📤 [fetchFrom21vek] Тело запроса:', JSON.stringify(requestBody));
    
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody),
      method: "POST"
    });

    console.log('📡 [fetchFrom21vek] Статус ответа:', response.status);
    
    if (!response.ok) {
      console.log('❌ [fetchFrom21vek] Ответ не OK, статус:', response.status);
      const errorText = await response.text();
      console.log('❌ [fetchFrom21vek] Текст ошибки:', errorText);
      return null;
    }

    const data = await response.json();
    console.log('📦 [fetchFrom21vek] data получен, keys:', Object.keys(data));
    
    const product = data.data?.productCards?.[0];
    if (!product) {
      console.log('❌ [fetchFrom21vek] product не найден в ответе');
      console.log('📦 [fetchFrom21vek] data.data:', JSON.stringify(data.data, null, 2).substring(0, 500));
      return null;
    }

    console.log('✅ [fetchFrom21vek] product найден');
    console.log('📦 [fetchFrom21vek] product.id =', product.id);
    console.log('📦 [fetchFrom21vek] product.name =', product.name);
    console.log('📦 [fetchFrom21vek] product.price =', product.price);
    console.log('📦 [fetchFrom21vek] product.packPrice =', product.packPrice);
    
    // Получаем рассрочку
    try {
      console.log('💳 [fetchFrom21vek] Запрашиваем рассрочку...');
      const partlyPayResponse = await fetch("https://gate.21vek.by/partly-pay/v2/products.calculate", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ 
          data: { 
            products: [{
              code: parseInt(code),
              price: parseFloat(product.packPrice || product.price)
            }]
          } 
        })
      });

      if (partlyPayResponse.ok) {
        const partlyPayResult = await partlyPayResponse.json();
        console.log('💳 [fetchFrom21vek] Рассрочка получена');
        if (partlyPayResult.data && partlyPayResult.data[0]) {
          product.monthly_payment = partlyPayResult.data[0].monthly_payment;
          product.no_overpayment_max_months = partlyPayResult.data[0].no_overpayment_max_months;
          console.log('💳 [fetchFrom21vek] monthly_payment:', product.monthly_payment);
          console.log('💳 [fetchFrom21vek] no_overpayment_max_months:', product.no_overpayment_max_months);
        }
      } else {
        console.log('⚠️ [fetchFrom21vek] Ошибка рассрочки, статус:', partlyPayResponse.status);
      }
    } catch (error) {
      console.log('⚠️ [fetchFrom21vek] Ошибка получения рассрочки:', error.message);
    }

    return product;
    
  } catch (err) {
    console.error('❌ [fetchFrom21vek] ОШИБКА:', err);
    console.error('❌ [fetchFrom21vek] Стек:', err.stack);
    return null;
  }
}
// Вспомогательная функция: добавить товар в БД
async function addProductToDatabase(product, originalCode) {
  console.log('💾 [addProductToDatabase] НАЧАЛО');
  console.log('💾 [addProductToDatabase] originalCode =', originalCode, 'тип:', typeof originalCode);
  console.log('💾 [addProductToDatabase] product =', product ? 'есть' : 'null');
  
  if (!product) {
    console.error('❌ [addProductToDatabase] product = null');
    throw new Error('product is null');
  }
  
  const code = originalCode;
  console.log('💾 [addProductToDatabase] code =', code);
  
  const realPrice = parseFloat(product.packPrice || product.price);
  console.log('💾 [addProductToDatabase] realPrice =', realPrice);
  
  const basePrice = product.price ? parseFloat(product.price) : null;
  const packPrice = product.packPrice ? parseFloat(product.packPrice) : null;
  const category = product.categories?.length ? product.categories[product.categories.length - 1].name : 'Товары';
  const brand = product.producerName || 'Без бренда';
  const now = new Date();
  const nameLower = product.name.toLowerCase();
  const monthly_payment = product.monthly_payment || null;
  const no_overpayment_max_months = product.no_overpayment_max_months || null;
  
  console.log('💾 [addProductToDatabase] category =', category);
  console.log('💾 [addProductToDatabase] brand =', brand);
  console.log('💾 [addProductToDatabase] nameLower =', nameLower);
  
  // Добавляем в product_codes
  console.log('💾 [addProductToDatabase] Добавляем в product_codes...');
  await db.execute({
    sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT DO NOTHING',
    args: [code]
  });
  
  // Добавляем в products_info
  console.log('💾 [addProductToDatabase] Добавляем в products_info...');
  await db.execute({
    sql: `
      INSERT INTO products_info (
        code, name, last_price, base_price, packPrice,
        monthly_payment, no_overpayment_max_months,
        link, category, brand, last_update, name_lower
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        last_price = excluded.last_price,
        base_price = excluded.base_price,
        packPrice = excluded.packPrice,
        monthly_payment = excluded.monthly_payment,
        no_overpayment_max_months = excluded.no_overpayment_max_months,
        link = excluded.link,
        category = excluded.category,
        brand = excluded.brand,
        last_update = excluded.last_update,
        name_lower = excluded.name_lower
    `,
    args: [
      code, product.name, realPrice, basePrice, packPrice,
      monthly_payment, no_overpayment_max_months,
      product.link || '', category, brand,
      now.toISOString().slice(0, 19).replace('T', ' '),
      nameLower
    ]
  });
  
  // Добавляем первую запись в price_history
  console.log('💾 [addProductToDatabase] Добавляем в price_history...');
  await db.execute({
    sql: `INSERT INTO price_history (product_code, product_name, price, updated_at)
          VALUES (?, ?, ?, ?)`,
    args: [code, product.name, realPrice, now.toISOString().slice(0, 19).replace('T', ' ')]
  });
  
  console.log('✅ [addProductToDatabase] Товар успешно добавлен');
}

// Вспомогательная функция: вернуть данные как /api/products/check/:code
async function returnProductData(code, res) {
  console.log('📤 [returnProductData] НАЧАЛО, code =', code);
  
  const product = await db.execute({
    sql: 'SELECT * FROM products_info WHERE code = ?',
    args: [code]
  });
  
  if (product.rows.length === 0) {
    console.log('❌ [returnProductData] Товар не найден в БД');
    return res.status(404).json({ error: 'Товар не найден' });
  }
  
  console.log('✅ [returnProductData] Товар найден:', product.rows[0].name);
  
  const history = await db.execute({
    sql: 'SELECT price, updated_at FROM price_history WHERE product_code = ? ORDER BY updated_at ASC',
    args: [code]
  });
  
  console.log('📊 [returnProductData] history.length =', history.rows.length);
  
  res.json({
    exists: true,
    product: {
      code: product.rows[0].code,
      name: product.rows[0].name,
      link: product.rows[0].link,
      category: product.rows[0].category || 'Товары',
      brand: product.rows[0].brand || 'Без бренда',
      base_price: product.rows[0].base_price,
      packPrice: product.rows[0].packPrice,
      monthly_payment: product.rows[0].monthly_payment,
      no_overpayment_max_months: product.rows[0].no_overpayment_max_months,
      currentPrice: product.rows[0].last_price,
      lastUpdate: product.rows[0].last_update,
      priceHistory: history.rows.map(row => ({
        date: row.updated_at,
        price: row.price
      }))
    }
  });
  
  console.log('✅ [returnProductData] Ответ отправлен');
}
// ПОЛУЧЕНИЕ ТОВАРОВ С ФИЛЬТРОМ ПО ДАТЕ (14ДН ПО)
export async function getProductsWithDateFilter(req, res, next) {
  try {
    const userId = req.user.id;
    const { 
      from, 
      to, 
      code,
      limit = 24, 
      offset = 0, 
      categories, 
      brands, 
      search, 
      sort = 'default',
      not_monitoring
    } = req.query;
    
    let startDate, endDate;
    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      endDate = new Date().toISOString().split('T')[0];
      startDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }
    
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
    
    if (code) {
      const product = await db.execute({
        sql: 'SELECT * FROM products_info WHERE code = ?',
        args: [code]
      });
      
      if (product.rows.length === 0) {
        return res.status(404).json({ error: 'Товар не найден' });
      }
      
      const history = await db.execute({
        sql: `
          SELECT price, updated_at
          FROM price_history
          WHERE product_code = ?
            AND DATE(updated_at) BETWEEN ? AND ?
          ORDER BY updated_at ASC
        `,
        args: [code, startDate, endDate]
      });
      
      const prices = {};
      const priceHistory = history.rows.map(row => ({
        date: row.updated_at,
        price: row.price
      }));
      
      allDates.forEach(date => {
        const dayRecords = priceHistory.filter(h => h.date.startsWith(date));
        if (dayRecords.length > 0) {
          const last = dayRecords.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          prices[date] = last.price;
        } else {
          const prev = priceHistory.filter(h => h.date < date)
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          if (prev) prices[date] = prev.price;
        }
      });
      
      const inMonitoring = await db.execute({
        sql: 'SELECT id FROM user_shelf WHERE user_id = ? AND product_code = ?',
        args: [userId, code]
      });
      
      return res.json({
        code: product.rows[0].code,
        name: product.rows[0].name,
        link: product.rows[0].link,
        category: product.rows[0].category || 'Товары',
        brand: product.rows[0].brand || 'Без бренда',
        base_price: product.rows[0].base_price,
        packPrice: product.rows[0].packPrice,
        monthly_payment: product.rows[0].monthly_payment,
        no_overpayment_max_months: product.rows[0].no_overpayment_max_months,
        currentPrice: product.rows[0].last_price,
        lastUpdate: product.rows[0].last_update,
        prices: prices,
        priceHistory: priceHistory,
        dates: allDates,
        from: startDate,
        to: endDate,
        exists: true,
        inMonitoring: inMonitoring.rows.length > 0
      });
    }
    
    const builder = new SafeQueryBuilder();
    
    builder.addInCondition('p.category', categories);
    builder.addInCondition('p.brand', brands);
    
    if (not_monitoring === 'true') {
      builder.addCondition(`p.code NOT IN (SELECT product_code FROM user_shelf WHERE user_id = ?)`, userId);
    }
    
    if (search && search.trim() !== '') {
      const searchLower = search.toLowerCase().trim();
      builder.addCondition(`(p.name_lower LIKE ? OR p.code LIKE ?)`, `%${searchLower}%`, `%${search}%`);
    }
    
    const { whereClause, params } = builder.buildWhere();
    const orderClause = getOrderByClause(sort);
    
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM products_info p ${whereClause}`,
      args: params
    });
    const totalFiltered = countResult.rows[0].count;
    
    const totalProductsResult = await db.execute('SELECT COUNT(*) as count FROM products_info');
    const totalAllProducts = totalProductsResult.rows[0].count;
    
    const products = await db.execute({
      sql: `
        SELECT 
          p.*,
          CASE WHEN us.user_id IS NOT NULL THEN 1 ELSE 0 END as inMonitoring
        FROM products_info p
        LEFT JOIN user_shelf us ON p.code = us.product_code AND us.user_id = ?
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `,
      args: [userId, ...params, parseInt(limit), parseInt(offset)]
    });
    
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
          code: p.code,
          name: p.name,
          link: p.link,
          category: p.category || 'Товары',
          brand: p.brand || 'Без бренда',
          base_price: p.base_price,
          packPrice: p.packPrice,
          monthly_payment: p.monthly_payment,
          no_overpayment_max_months: p.no_overpayment_max_months,
          currentPrice: p.last_price,
          lastUpdate: p.last_update,
          prices: prices,
          priceHistory: productHistory,
          inMonitoring: p.inMonitoring === 1,
          exists: true
        };
      });
    }
    
    res.json({
      products: products.rows,
      dates: allDates,
      total: totalFiltered,
      totalProducts: totalAllProducts,
      from: startDate,
      to: endDate,
      hasMore: parseInt(offset) + parseInt(limit) < totalFiltered
    });
    
  } catch (err) {
    Logger.error('Ошибка получения истории цен', err);
    next(err);
  }
}
