import db from '../../database.js';
import Logger from '../services/logger.js';

export async function searchExternal(req, res, next) {
  Logger.debug('Внешний поиск', { query: req.query.query, userId: req.user?.id });
  
  try {
    const { query } = req.query;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Поисковый запрос обязателен' });
    }
    
    const searchUrl = `https://gate.21vek.by/search-composer/api/v1/search/suggest?query=${encodeURIComponent(query)}&mode=desktop`;
    
    const response = await fetch(searchUrl, {
      headers: {
        "accept": "application/json",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    
    if (!response.ok) {
      Logger.error('Ошибка ответа от 21vek', null, { status: response.status, query });
      return res.status(502).json({ 
        error: 'Ошибка при обращении к внешнему API',
        status: response.status 
      });
    }
    
    const data = await response.json();
    const products = [];
    const productsGroup = data.data?.find(group => group.group_type === 'products');
    
    if (productsGroup && productsGroup.items) {
      for (const item of productsGroup.items) {
        const cleanCode = item.product_id?.replace(/\./g, '') || '';
        if (!cleanCode) continue;
        
        let price = null;
        if (item.price && item.price !== 'нет на складе') {
          const priceStr = item.price.replace(/\s/g, '').replace(',', '.');
          price = parseFloat(priceStr);
        }
        
        let exists = false;
        try {
          const existingResult = await db.execute({
            sql: 'SELECT code FROM products_info WHERE code = ?',
            args: [cleanCode]
          });
          exists = existingResult.rows.length > 0;
        } catch (dbErr) {
          Logger.error('Ошибка проверки БД', dbErr, { code: cleanCode });
        }
        
        products.push({
          code: cleanCode,
          originalCode: item.product_id,
          name: item.name || 'Без названия',
          price: price || 0,
          currentPrice: price || 0,
          url: item.url || null,
          image: item.image || null,
          exists: exists,
          fromExternal: true
        });
      }
    }
    
    Logger.info('Внешний поиск выполнен', { 
      query, 
      productsFound: products.length,
      userId: req.user?.id 
    });
    
    res.json({ query, products });
    
  } catch (err) {
    Logger.error('Ошибка внешнего поиска', err, { query: req.query?.query, userId: req.user?.id });
    next(err);
  }
}