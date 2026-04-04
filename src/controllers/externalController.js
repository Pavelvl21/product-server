import db from '../../database.js';
import Logger from '../services/logger.js';

export async function unifiedSearch(req, res, next) {
  try {
    const { query } = req.query;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Поисковый запрос обязателен' });
    }

    const searchTerm = query.trim().toLowerCase();
    
    // ========== 1. ЛОКАЛЬНЫЙ ПОИСК В БД ==========
    const localProducts = await db.execute({
      sql: `
        SELECT 
          code, name, link, category, brand, 
          last_price as price, base_price, packPrice,
          monthly_payment, no_overpayment_max_months, last_update,
          name_lower
        FROM products_info
        WHERE name_lower LIKE ? OR code LIKE ?
        LIMIT 20
      `,
      args: [`%${searchTerm}%`, `%${searchTerm}%`]
    });
    
    const localCodesSet = new Set(localProducts.rows.map(p => p.code));
    
    // Форматируем локальные товары
    const formattedLocal = localProducts.rows.map(p => ({
      code: p.code,
      name: p.name,
      link: p.link,
      category: p.category || 'Товары',
      brand: p.brand || 'Без бренда',
      base_price: p.base_price,
      packPrice: p.packPrice,
      monthly_payment: p.monthly_payment,
      no_overpayment_max_months: p.no_overpayment_max_months,
      currentPrice: p.price,
      lastUpdate: p.last_update,
      exists: true,
      source: 'local'
    }));
    
    // ========== 2. ВНЕШНИЙ ПОИСК НА 21VEK ==========
    const externalResponse = await fetch(
      `https://gate.21vek.by/search-composer/api/v1/search/suggest?query=${encodeURIComponent(query)}&mode=desktop`,
      {
        headers: {
          "accept": "application/json",
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      }
    );
    
    if (!externalResponse.ok) {
      return res.json({
        query,
        localCount: formattedLocal.length,
        externalCount: 0,
        products: formattedLocal
      });
    }
    
    const externalData = await externalResponse.json();
    const productsGroup = externalData.data?.find(group => group.group_type === 'products');
    const externalItems = productsGroup?.items || [];
    
    // Собираем коды внешних товаров для массовой проверки наличия в БД
    const externalCodes = externalItems
      .map(item => item.product_id?.replace(/\./g, '') || '')
      .filter(code => code && !localCodesSet.has(code));
    
    // Массовая проверка существования в БД
    const existingCodesSet = new Set();
    if (externalCodes.length) {
      const placeholders = externalCodes.map(() => '?').join(',');
      const existingResult = await db.execute({
        sql: `SELECT code FROM products_info WHERE code IN (${placeholders})`,
        args: externalCodes
      });
      existingResult.rows.forEach(row => existingCodesSet.add(row.code));
    }
    
    // Получаем полные данные из БД для товаров, которые уже есть (и не попали в локальный поиск)
    const existingInDbCodes = [...existingCodesSet];
    let existingProductsData = [];
    if (existingInDbCodes.length) {
      const placeholders = existingInDbCodes.map(() => '?').join(',');
      const existingFull = await db.execute({
        sql: `
          SELECT 
            code, name, link, category, brand, 
            last_price as price, base_price, packPrice,
            monthly_payment, no_overpayment_max_months, last_update
          FROM products_info
          WHERE code IN (${placeholders})
        `,
        args: existingInDbCodes
      });
      existingProductsData = existingFull.rows.map(p => ({
        code: p.code,
        name: p.name,
        link: p.link,
        category: p.category || 'Товары',
        brand: p.brand || 'Без бренда',
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        currentPrice: p.price,
        lastUpdate: p.last_update,
        exists: true,
        source: 'existing'  // товар уже в БД, но не подошел под локальный поиск
      }));
    }
    
    // Форматируем внешние товары, которых НЕТ в БД
    const formattedExternal = [];
    for (const item of externalItems) {
      const cleanCode = item.product_id?.replace(/\./g, '') || '';
      if (!cleanCode) continue;
      if (localCodesSet.has(cleanCode)) continue;
      if (existingCodesSet.has(cleanCode)) continue; // уже обработали как existing
      
      let price = null;
      if (item.price && item.price !== 'нет на складе') {
        const priceStr = item.price.replace(/\s/g, '').replace(',', '.');
        price = parseFloat(priceStr);
      }
      
      formattedExternal.push({
        code: cleanCode,
        originalCode: item.product_id,
        name: item.name || 'Без названия',
        price: price || 0,
        currentPrice: price || 0,
        url: item.url || null,
        image: item.image || null,
        exists: false,
        source: 'external',
        fromExternal: true
      });
    }
    
    // ========== 3. ОБЪЕДИНЯЕМ РЕЗУЛЬТАТЫ ==========
    const allProducts = [...formattedLocal, ...existingProductsData, ...formattedExternal];
    
    res.json({
      query,
      localCount: formattedLocal.length,
      existingCount: existingProductsData.length,
      externalCount: formattedExternal.length,
      total: allProducts.length,
      products: allProducts
    });
    
  } catch (err) {
    console.error('❌ Ошибка unifiedSearch:', err);
    Logger.error('Ошибка unifiedSearch', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
