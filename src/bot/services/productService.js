import { config } from '../../../src/config/env.js';
import Logger from '../../../src/services/logger.js';

export async function getProductsFromServer() {
  const url = `${config.API_URL}/api/bot/products`;
  console.log('🔍 Запрашиваемый URL:', url);  // ← добавьте эту строку
  
  try {
    const response = await fetch(url, {
      headers: { 'x-bot-key': config.SECRET_KEY },
      timeout: 10000
    });
    console.log('📡 Статус ответа:', response.status);
    
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
    
    console.log('🔍 [getPriceChanges] Всего товаров от сервера:', data.products.length);
    
    // Логируем товар 7093 отдельно
    const targetProduct = data.products.find(p => p.code === '7093');
    if (targetProduct) {
      console.log('🔍 [getPriceChanges] Товар 7093:', {
        code: targetProduct.code,
        name: targetProduct.name,
        priceToday: targetProduct.priceToday,
        priceYesterday: targetProduct.priceYesterday,
        diff: targetProduct.priceToday - targetProduct.priceYesterday,
        absDiff: Math.abs(targetProduct.priceToday - targetProduct.priceYesterday)
      });
    } else {
      console.log('🔍 [getPriceChanges] Товар 7093 не найден в ответе сервера');
    }
    
    const changes = data.products
      .filter(p => {
        const hasToday = p.priceToday !== null && p.priceToday !== undefined;
        const hasYesterday = p.priceYesterday !== null && p.priceYesterday !== undefined;
        const diff = Math.abs(p.priceToday - p.priceYesterday);
        const isValid = hasToday && hasYesterday && diff > 0.01;
        
        if (p.code === '7093') {
          console.log('🔍 [getPriceChanges] Фильтр для 7093:', {
            hasToday,
            hasYesterday,
            diff,
            isValid,
            priceToday: p.priceToday,
            priceYesterday: p.priceYesterday
          });
        }
        
        return isValid;
      })
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
    
    console.log('🔍 [getPriceChanges] Найдено изменений:', changes.length);
    console.log('🔍 [getPriceChanges] Коды товаров с изменениями:', changes.map(c => c.product_code));
    
    // Сортировка
    changes.sort((a, b) => {
      if (a.isDecrease !== b.isDecrease) {
        return a.isDecrease ? 1 : -1;
      }
      if (!a.isDecrease) {
        return b.change - a.change;
      } else {
        return Math.abs(a.change) - Math.abs(b.change);
      }
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