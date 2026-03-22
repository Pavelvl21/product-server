import { config } from '../../../src/config/env.js';
import Logger from '../../../src/services/logger.js';

export async function getProductsFromServer() {
  const url = `${config.API_URL}/api/bot/products`;
  
  try {
    const response = await fetch(url, {
      headers: { 'x-bot-key': config.SECRET_KEY },
      timeout: 10000
    });
    
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    Logger.error('Ошибка получения товаров с сервера', err);
    return null;
  }
}

export async function getPriceChanges() {
  try {
    const data = await getProductsFromServer();
    if (!data?.products) return [];
    
    const changes = data.products
      .filter(p => p.priceToday && p.priceYesterday && Math.abs(p.priceToday - p.priceYesterday) > 0.01)
      .map(p => ({
        product_code: p.code,
        product_name: p.name,
        current_price: p.priceToday,
        previous_price: p.priceYesterday,
        change: p.priceToday - p.priceYesterday,
        percent: ((p.priceToday - p.priceYesterday) / p.priceYesterday * 100).toFixed(1),
        base_price: p.base_price,
        packPrice: p.packPrice,
        monthly_payment: p.monthly_payment,
        no_overpayment_max_months: p.no_overpayment_max_months,
        link: p.link,
        category: p.category,
        brand: p.brand,
        isDecrease: p.priceToday < p.priceYesterday
      }));
    
    // Сортировка: сначала повышения (от большего к меньшему), затем снижения (от большего к меньшему)
    changes.sort((a, b) => {
      // Сначала по типу (повышения выше)
      if (a.isDecrease !== b.isDecrease) {
        return a.isDecrease ? 1 : -1;
      }
      // Затем по абсолютному значению изменения
      return Math.abs(b.change) - Math.abs(a.change);
    });
    
    return changes;
  } catch (err) {
    Logger.error('Ошибка получения изменений цен', err);
    return [];
  }
}

export async function getProductsByCategory(categories) {
  try {
    const data = await getProductsFromServer();
    if (!data?.products) return [];
    return data.products.filter(p => categories.includes(p.category));
  } catch (err) {
    Logger.error('Ошибка получения товаров по категориям', err);
    return [];
  }
}