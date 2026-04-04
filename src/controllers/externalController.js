import db from '../../database.js';
import Logger from '../services/logger.js';

// Вспомогательная функция для получения полных данных товара с 21vek
async function fetchFullProductInfo(code) {
  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: [parseInt(code)],
        isAdult: false,
        limit: 100
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    const product = data.data?.productCards?.[0];
    if (!product) return null;

    // Получаем рассрочку
    try {
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
        if (partlyPayResult.data && partlyPayResult.data[0]) {
          product.monthly_payment = partlyPayResult.data[0].monthly_payment;
          product.no_overpayment_max_months = partlyPayResult.data[0].no_overpayment_max_months;
        }
      }
    } catch (error) {
      console.log('⚠️ Ошибка получения рассрочки:', error.message);
    }

    return product;
  } catch (err) {
    console.error(`❌ Ошибка fetchFullProductInfo для ${code}:`, err);
    return null;
  }
}

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
    
    // Создаём Map для быстрого доступа к локальным товарам по коду
    const localProductsMap = new Map();
    for (const p of localProducts.rows) {
      localProductsMap.set(p.code, {
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
        exists: true
      });
    }
    
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
      // Если внешний поиск не удался, возвращаем только локальные результаты
      const products = Array.from(localProductsMap.values());
      return res.json({
        query,
        total: products.length,
        products: products
      });
    }
    
    const externalData = await externalResponse.json();
    const productsGroup = externalData.data?.find(group => group.group_type === 'products');
    const externalItems = productsGroup?.items || [];
    
    // Собираем коды внешних товаров
    const externalCodes = externalItems
      .map(item => item.product_id?.replace(/\./g, '') || '')
      .filter(code => code && !localProductsMap.has(code));
    
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
    const existingProductsMap = new Map();
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
      for (const p of existingFull.rows) {
        existingProductsMap.set(p.code, {
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
          exists: true
        });
      }
    }
    
    // Определяем коды товаров, которых нет в БД (нужно получить полную информацию)
    const notInDbCodes = externalCodes.filter(code => !existingCodesSet.has(code));
    
    // Получаем полную информацию для товаров, которых нет в БД
    const externalFullProducts = [];
    for (const code of notInDbCodes) {
      const fullInfo = await fetchFullProductInfo(code);
      if (fullInfo) {
        externalFullProducts.push({
          code: code,
          name: fullInfo.name,
          link: fullInfo.link || null,
          category: fullInfo.categories?.length ? fullInfo.categories[fullInfo.categories.length - 1].name : 'Товары',
          brand: fullInfo.producerName || 'Без бренда',
          base_price: fullInfo.price ? parseFloat(fullInfo.price) : null,
          packPrice: fullInfo.packPrice ? parseFloat(fullInfo.packPrice) : null,
          monthly_payment: fullInfo.monthly_payment || null,
          no_overpayment_max_months: fullInfo.no_overpayment_max_months || null,
          currentPrice: parseFloat(fullInfo.packPrice || fullInfo.price),
          image: fullInfo.image || null,
          exists: false
        });
      } else {
        // Если не удалось получить полную информацию, используем данные из поиска
        const searchItem = externalItems.find(item => item.product_id?.replace(/\./g, '') === code);
        let price = null;
        if (searchItem?.price && searchItem.price !== 'нет на складе') {
          const priceStr = searchItem.price.replace(/\s/g, '').replace(',', '.');
          price = parseFloat(priceStr);
        }
        externalFullProducts.push({
          code: code,
          name: searchItem?.name || 'Без названия',
          price: price || 0,
          currentPrice: price || 0,
          url: searchItem?.url || null,
          image: searchItem?.image || null,
          exists: false
        });
      }
    }
    
    // Формируем итоговый список товаров
    const products = [];
    
    // Добавляем локальные товары
    for (const product of localProductsMap.values()) {
      products.push(product);
    }
    
    // Добавляем товары, которые есть в БД (не попавшие в локальный поиск)
    for (const product of existingProductsMap.values()) {
      products.push(product);
    }
    
    // Добавляем внешние товары с полной информацией
    for (const product of externalFullProducts) {
      products.push(product);
    }
    
    res.json({
      query,
      total: products.length,
      products: products
    });
    
  } catch (err) {
    console.error('❌ Ошибка unifiedSearch:', err);
    Logger.error('Ошибка unifiedSearch', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
