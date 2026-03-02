import db from './database.js';
import { sendTelegramMessage, formatPriceChangeNotification } from './telegramBot.js';

const BATCH_SIZE = 100;
const CONCURRENT_LIMIT = 3;

export async function updateAllPrices() {
  const startTime = Date.now();
  console.log('🚀 Начинаем обновление цен:', new Date().toLocaleString());

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    // Разбиваем на пачки
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`📊 Пачек для обработки: ${batches.length}`);

    let stats = {
      updated: 0,
      newRecords: 0,
      errors: 0,
      totalProducts: allCodes.length
    };

    // Обрабатываем пачки параллельно
    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.all(
        currentBatches.map(batch => processBatch(batch))
      );

      results.forEach(result => {
        stats.updated += result.updated || 0;
        stats.newRecords += result.newRecords || 0;
        stats.errors += result.errors || 0;
      });

      console.log(`📊 Прогресс: ${Math.min(i + CONCURRENT_LIMIT, batches.length)}/${batches.length} пачек`);
    }

    stats.duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`✅ Обновление завершено за ${stats.duration} сек`);
    
    // Отправляем уведомление в Telegram
    await sendBatchUpdateNotification(stats);

  } catch (error) {
    console.error('❌ Ошибка обновления:', error);
    await sendTelegramMessage(`⚠️ Ошибка обновления: ${error.message}`);
  }
}

async function processBatch(batch) {
  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: batch.map(code => parseInt(code)),
        isAdult: false,
        limit: batch.length
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const products = data.data?.productCards || [];
    
    let batchStats = { updated: products.length, newRecords: 0, errors: 0 };

    for (const product of products) {
      try {
        const saved = await saveProductData(product);
        if (saved.isNew) batchStats.newRecords++;
      } catch (err) {
        batchStats.errors++;
      }
    }

    return batchStats;

  } catch (error) {
    return { updated: 0, newRecords: 0, errors: batch.length };
  }
}

async function saveProductData(product) {
  const code = product.code.toString();
  const price = parseFloat(product.packPrice || product.price);
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  const category = product.categories?.length > 0 
    ? product.categories[product.categories.length - 1].name 
    : 'Товары';
  const brand = product.producerName || 'Без бренда';

  // Проверяем последнюю цену
  const lastRecord = await db.execute({
    sql: `SELECT price FROM price_history 
          WHERE product_code = ? ORDER BY updated_at DESC LIMIT 1`,
    args: [code]
  });

  // Проверяем запись за сегодня
  const todayRecord = await db.execute({
    sql: `SELECT id FROM price_history 
          WHERE product_code = ? AND DATE(updated_at) = ? LIMIT 1`,
    args: [code, today]
  });

  const lastPrice = lastRecord.rows[0]?.price;
  const isNew = todayRecord.rows.length === 0;
  const priceChanged = lastPrice !== undefined && Math.abs(price - lastPrice) > 0.01;

  // Сохраняем в историю если нужно
  if (isNew || priceChanged) {
    await db.execute({
      sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
      args: [code, product.name, price, now.toISOString().slice(0, 19).replace('T', ' ')]
    });

    // Уведомляем об изменении цены
    if (priceChanged) {
      const notification = formatPriceChangeNotification(
        { ...product, code }, 
        lastPrice, 
        price
      );
      await sendTelegramMessage(notification);
    }
  }

  // Обновляем информацию о товаре
  await db.execute({
    sql: `
      INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        last_price = excluded.last_price,
        link = excluded.link,
        category = excluded.category,
        brand = excluded.brand,
        last_update = excluded.last_update
    `,
    args: [
      code, 
      product.name, 
      price, 
      product.link || '', 
      category, 
      brand,
      now.toISOString().slice(0, 19).replace('T', ' ')
    ]
  });

  return { isNew, priceChanged };
}

export async function updatePricesForNewCode(code) {
  console.log(`🔄 Обновление для нового кода: ${code}`);
  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [parseInt(code)], isAdult: false, limit: 1 })
    });

    if (!response.ok) return;

    const data = await response.json();
    const product = data.data?.productCards[0];
    
    if (product) {
      await saveProductData(product);
      console.log(`✅ Данные для ${code} загружены`);
    }
  } catch (error) {
    console.error(`❌ Ошибка для кода ${code}:`, error);
  }
}

export async function cleanOldRecords() {
  console.log('🧹 Очистка старых записей...');
  const result = await db.execute({
    sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
    args: []
  });
  console.log(`✅ Удалено ${result.rowsAffected} записей`);
}

function sendBatchUpdateNotification(stats) {
  const message = `
📊 <b>Массовое обновление цен</b>

✅ Обновлено: ${stats.updated}
🆕 Новых записей: ${stats.newRecords}
⚠️ Ошибок: ${stats.errors}
⏱ Время: ${stats.duration} сек.
📈 Всего товаров: ${stats.totalProducts}
`;
  return sendTelegramMessage(message);
}
