import db from './database.js';
import { updateCategoryBrandRelations } from './categoryRelations.js';
import { sendTelegramMessage, formatPriceChangeNotification } from './telegramBot.js';
import { notifyProductSubscribers } from './telegramBroadcast.js';

async function insertPriceRecord(code, name, price, timestamp) {
  await db.execute({
    sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
    args: [code, name, price, timestamp.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

async function saveProductData(product, timestamp) {
  const code = product.code.toString();
  
  const realPrice = parseFloat(product.packPrice || product.price);
  const basePrice = product.price ? parseFloat(product.price) : null;
  const packPrice = product.packPrice ? parseFloat(product.packPrice) : null;
  
  const now = timestamp || new Date();
  const today = now.toISOString().split('T')[0];

  const monthly_payment = product.monthly_payment || null;
  const no_overpayment_max_months = product.no_overpayment_max_months || null;

  let category = 'Товары';
  if (product.categories && product.categories.length > 0) {
    category = product.categories[product.categories.length - 1].name;
  }
  const brand = product.producerName || 'Без бренда';

  // 📊 Статистика по этой операции
  const stats = {
    priceChanged: false,
    priceInserted: false,
    productUpdated: false,
    categoryUpdated: false
  };

  try {
    const lastRecord = await db.execute({
      sql: `SELECT price, updated_at FROM price_history 
            WHERE product_code = ? 
            ORDER BY updated_at DESC LIMIT 1`,
      args: [code]
    });

    const todayRecord = await db.execute({
      sql: `SELECT id FROM price_history 
            WHERE product_code = ? AND DATE(updated_at) = ? 
            LIMIT 1`,
      args: [code, today]
    });

    const lastPrice = lastRecord.rows[0]?.price;

    const productWithPrices = {
      ...product,
      code,
      category,
      realPrice,
      basePrice,
      packPrice
    };

    // Проверяем, есть ли товар в мониторинге
    const monitoringCheck = await db.execute({
      sql: 'SELECT 1 FROM user_shelf WHERE product_code = ? LIMIT 1',
      args: [code]
    });
    
    const isMonitored = monitoringCheck.rows.length > 0;

    // ☑️ Проверяем, изменилась ли цена
    const priceChanged = lastPrice !== undefined && Math.abs(realPrice - lastPrice) > 0.01;
    stats.priceChanged = priceChanged;

    // ☑️ Решаем, нужно ли вставлять в историю
    const shouldInsertPrice = priceChanged || lastPrice === undefined;
    
    if (shouldInsertPrice) {
      await insertPriceRecord(code, product.name, realPrice, now);
      stats.priceInserted = true;
      
      if (priceChanged && isMonitored) {
        const notification = formatPriceChangeNotification(
          productWithPrices, 
          lastPrice, 
          realPrice
        );
        
        await notifyProductSubscribers(
          code,
          productWithPrices,
          lastPrice,
          realPrice,
          formatPriceChangeNotification
        );
      }
    }

    // Всегда обновляем products_info
    const nameLower = product.name ? product.name.toLowerCase() : '';
    
    await db.execute({
      sql: `
        INSERT INTO products_info (
          code, name, last_price, base_price, packPrice,
          monthly_payment, no_overpayment_max_months,
          link, category, brand, last_update,
          name_lower
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
        code, 
        product.name, 
        realPrice,
        basePrice,
        packPrice,
        monthly_payment,
        no_overpayment_max_months,
        product.link || '', 
        category, 
        brand, 
        now.toISOString().slice(0, 19).replace('T', ' '),
        nameLower
      ]
    });
    stats.productUpdated = true;

    // Обновляем связи категорий
    // await updateCategoryBrandRelations(category, brand);
    // stats.categoryUpdated = true;

    return stats;

  } catch (error) {
    console.error(`❌ Критическая ошибка при сохранении товара ${code}:`, error.message);
    throw error;
  }
}

export async function updatePricesForNewCode(code) {
  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: [parseInt(code)],
        isAdult: false,
        limit: 1
      }),
      method: "POST"
    });

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const product = data.data.productCards[0];

    if (!product) {
      return;
    }

    const now = new Date();
    
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

    await saveProductData(product, now);

  } catch (error) {
    console.error(`❌ Критическая ошибка при загрузке кода ${code}:`, error.message);
  }
}

export async function updateAllPrices() {
  const startTime = Date.now();
  console.log(`\n🚀 Запуск планового обновления цен: ${new Date().toLocaleString('ru-RU')}`);

  // 📊 СЧЁТЧИКИ ДЛЯ ДИАГНОСТИКИ
  let totalProcessed = 0;
  let totalErrors = 0;
  let totalPriceChanges = 0;
  let totalPriceInserts = 0;
  let totalProductUpdates = 0;
  let totalCategoryUpdates = 0;

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    console.log(`📦 Всего товаров для обновления: ${allCodes.length}`);

    const BATCH_SIZE = 100;
    const CONCURRENT_LIMIT = 2;
    
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }

    const processBatch = async (batch, batchIndex) => {
      const batchStartTime = new Date();
      
      let batchProcessed = 0;
      let batchErrors = 0;
      let batchPriceChanges = 0;
      let batchPriceInserts = 0;
      let batchProductUpdates = 0;
      let batchCategoryUpdates = 0;
      
      let requestDelay = 100;

      for (const code of batch) {
        try {
          batchProcessed++;
          
          const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
            headers: {
              "accept": "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({
              ids: [parseInt(code)],
              isAdult: false,
              limit: 1
            }),
            method: "POST"
          });

if (!response.ok) {
  console.log(`❌ ТОВАР ${code} НЕ ОБНОВЛЁН! Статус: ${response.status}`);
  batchErrors++;
  continue;
}

          const data = await response.json();
          const product = data.data.productCards[0];

          if (!product) {
            batchErrors++;
            continue;
          }
          
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
            // Игнорируем ошибки рассрочки
          }
          
          const stats = await saveProductData(product, batchStartTime);
          
          batchPriceChanges += stats.priceChanged ? 1 : 0;
          batchPriceInserts += stats.priceInserted ? 1 : 0;
          batchProductUpdates += stats.productUpdated ? 1 : 0;
          batchCategoryUpdates += stats.categoryUpdated ? 1 : 0;
          
          await new Promise(resolve => setTimeout(resolve, requestDelay));
          
          if (requestDelay > 100) {
            requestDelay = Math.max(requestDelay - 5, 100);
          }
          
        } catch (error) {
          batchErrors++;
          requestDelay = Math.min(requestDelay + 20, 500);
          await new Promise(resolve => setTimeout(resolve, requestDelay));
        }
      }

      console.log(`\n📊 Батч ${batchIndex + 1} завершен:`);
      console.log(`   - Обработано: ${batchProcessed} товаров`);
      console.log(`   - Ошибок: ${batchErrors}`);
      console.log(`   - Цена изменилась у: ${batchPriceChanges} товаров`);
      console.log(`   - Сделано INSERT в price_history: ${batchPriceInserts}`);
      console.log(`   - Сделано UPDATE products_info: ${batchProductUpdates}`);
      console.log(`   - Сделано операций с category_brand_relations: ${batchCategoryUpdates}`);

      return { 
        processed: batchProcessed, 
        errors: batchErrors,
        priceChanges: batchPriceChanges,
        priceInserts: batchPriceInserts,
        productUpdates: batchProductUpdates,
        categoryUpdates: batchCategoryUpdates
      };
    };

    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      
      const results = await Promise.all(
        currentBatches.map((batch, idx) => processBatch(batch, i + idx))
      );
      
      results.forEach(result => {
        totalProcessed += result.processed;
        totalErrors += result.errors;
        totalPriceChanges += result.priceChanges;
        totalPriceInserts += result.priceInserts;
        totalProductUpdates += result.productUpdates;
        totalCategoryUpdates += result.categoryUpdates;
      });
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✅ ПЛАНОВОЕ ОБНОВЛЕНИЕ ЗАВЕРШЕНО`);
    console.log(`⏱️ Время выполнения: ${totalTime} сек`);
    console.log(`📊 Обработано товаров: ${totalProcessed}`);
    console.log(`❌ Ошибок: ${totalErrors}`);
    console.log(`\n📈 ДЕТАЛЬНАЯ СТАТИСТИКА ЗАПИСЕЙ:`);
    console.log(`   - Цена изменилась у: ${totalPriceChanges} товаров`);
    console.log(`   - INSERT в price_history: ${totalPriceInserts}`);
    console.log(`   - UPDATE products_info: ${totalProductUpdates}`);
    console.log(`   - Операции с category_brand_relations: ${totalCategoryUpdates}`);
    console.log(`   - ВСЕГО ОПЕРАЦИЙ ЗАПИСИ: ${totalPriceInserts + totalProductUpdates + totalCategoryUpdates}`);

  } catch (error) {
    console.error('\n❌ КРИТИЧЕСКАЯ ОШИБКА ПРИ ОБНОВЛЕНИИ ЦЕН:', error.message);
    
    await sendTelegramMessage(`
⚠️ Критическая ошибка при массовом обновлении

${error.message}

🕐 ${new Date().toLocaleString('ru-RU')}
`);
  }
}

export async function cleanOldRecords() {
  try {
    await db.execute({
      sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
      args: []
    });
  } catch (err) {
    console.error('❌ Критическая ошибка при очистке:', err.message);
  }
}

export async function sendWeeklyStats() {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    const startStr = startDate.toISOString().split('T')[0];
    
    const changes = await db.execute({
      sql: `
        SELECT 
          product_code,
          product_name,
          price,
          updated_at,
          LAG(price) OVER (PARTITION BY product_code ORDER BY updated_at) as prev_price
        FROM price_history
        WHERE updated_at >= datetime(?)
        ORDER BY updated_at ASC
      `,
      args: [startStr]
    });

    let increases = 0;
    let decreases = 0;
    let totalIncreasePercent = 0;
    let totalDecreasePercent = 0;
    let maxIncrease = { percent: 0, name: '', code: '' };
    let maxDecrease = { percent: 0, name: '', code: '' };
    
    changes.rows.forEach(row => {
      if (row.prev_price) {
        const oldPrice = parseFloat(row.prev_price);
        const newPrice = parseFloat(row.price);
        const changePercent = ((newPrice - oldPrice) / oldPrice) * 100;
        
        if (changePercent > 0.01) {
          increases++;
          totalIncreasePercent += changePercent;
          if (changePercent > maxIncrease.percent) {
            maxIncrease = {
              percent: changePercent,
              name: row.product_name,
              code: row.product_code
            };
          }
        } else if (changePercent < -0.01) {
          decreases++;
          totalDecreasePercent += Math.abs(changePercent);
          if (Math.abs(changePercent) > maxDecrease.percent) {
            maxDecrease = {
              percent: Math.abs(changePercent),
              name: row.product_name,
              code: row.product_code
            };
          }
        }
      }
    });

    const totalProducts = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const totalCount = totalProducts.rows[0].count;

    const avgIncrease = increases > 0 ? (totalIncreasePercent / increases).toFixed(1) : '0.0';
    const avgDecrease = decreases > 0 ? (totalDecreasePercent / decreases).toFixed(1) : '0.0';
    const totalChanges = increases + decreases;

    let message = `📊 Итоги мониторинга за 7 дней\n\n`;
    message += `📈 Общая статистика:\n`;
    message += `• Всего товаров: ${totalCount}\n`;
    message += `• Изменений цен: ${totalChanges}\n\n`;
    
    message += `📊 Динамика изменений:\n`;
    message += `• 🔼 Повышение: ${increases}\n`;
    message += `  Среднее повышение: +${avgIncrease}%\n`;
    message += `• 🔻 Снижение: ${decreases}\n`;
    message += `  Среднее снижение: -${avgDecrease}%\n\n`;

    if (totalChanges > 0) {
      message += `💰 Самое большое изменение:\n`;
      if (maxIncrease.percent > 0) {
        message += `• ⬆️ ${maxIncrease.name} (код ${maxIncrease.code}): +${maxIncrease.percent.toFixed(1)}%\n`;
      }
      if (maxDecrease.percent > 0) {
        message += `• ⬇️ ${maxDecrease.name} (код ${maxDecrease.code}): -${maxDecrease.percent.toFixed(1)}%\n`;
      }
      message += `\n`;
    }

    const formatDate = (date) => {
      return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    };

    message += `🕐 Период: ${formatDate(startDate)} - ${formatDate(endDate)}`;

    await sendTelegramMessage(message);

  } catch (error) {
    console.error('❌ Критическая ошибка при формировании статистики:', error.message);
  }
}
