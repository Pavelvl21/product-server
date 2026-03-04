import db from './database.js';
import { sendTelegramMessage, formatPriceChangeNotification } from './telegramBot.js';
import { notifyPriceChange } from './telegramBroadcast.js';

async function insertPriceRecord(code, name, price, timestamp) {
  await db.execute({
    sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
    args: [code, name, price, timestamp.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

async function saveProductData(product, timestamp) {
  const code = product.code.toString();
  const price = parseFloat(product.packPrice || product.price);
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

    // Создаем объект товара с категорией для уведомлений
    const productWithCategory = {
      ...product,
      code,
      category
    };

    if (todayRecord.rows.length === 0) {
      // Первая запись за сегодня
      if (lastPrice !== undefined && Math.abs(price - lastPrice) > 0.01) {
        console.log(`📝 Первая запись за ${today} для ${code} (цена изменилась: ${lastPrice} → ${price})`);
        await insertPriceRecord(code, product.name, price, now);
        
        const notification = formatPriceChangeNotification(
          productWithCategory, 
          lastPrice, 
          price
        );
        
        // Отправка админу
        await sendTelegramMessage(notification);
        
        // Отправка всем подписанным на категорию
        await notifyPriceChange(
          productWithCategory,
          lastPrice,
          price,
          formatPriceChangeNotification
        );
      } else {
        // Первая запись, но цена не изменилась - просто сохраняем без уведомлений
        await insertPriceRecord(code, product.name, price, now);
      }
      
    } else {
      if (Math.abs(price - lastPrice) > 0.01) {
        console.log(`🔄 Цена изменилась для ${code}: ${lastPrice} → ${price}`);
        await insertPriceRecord(code, product.name, price, now);
        
        const notification = formatPriceChangeNotification(
          productWithCategory, 
          lastPrice, 
          price
        );
        
        // Отправка админу
        await sendTelegramMessage(notification);
        
        // Отправка всем подписанным на категорию
        await notifyPriceChange(
          productWithCategory,
          lastPrice,
          price,
          formatPriceChangeNotification
        );
        
      } else {
        // Цена не изменилась - ничего не делаем и не логируем
      }
    }

    await db.execute({
      sql: `
        INSERT INTO products_info (
          code, name, last_price, packPrice, 
          monthly_payment, no_overpayment_max_months,
          link, category, brand, last_update
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          last_price = excluded.last_price,
          packPrice = excluded.packPrice,
          monthly_payment = excluded.monthly_payment,
          no_overpayment_max_months = excluded.no_overpayment_max_months,
          link = excluded.link,
          category = excluded.category,
          brand = excluded.brand,
          last_update = excluded.last_update
      `,
      args: [
        code, 
        product.name, 
        price, 
        packPrice,
        monthly_payment,
        no_overpayment_max_months,
        product.link || '', 
        category, 
        brand, 
        now.toISOString().slice(0, 19).replace('T', ' ')
      ]
    });

  } catch (error) {
    console.error(`❌ Ошибка в saveProductData для ${code}:`, error);
    throw error;
  }
}

export async function updatePricesForNewCode(code) {
  console.log(`🔄 Начинаем обновление для нового кода: ${code}`);

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
      console.error(`❌ Ошибка HTTP для кода ${code}:`, response.status);
      return;
    }

    const data = await response.json();
    const product = data.data.productCards[0];

    if (!product) {
      console.log(`📭 Нет данных для кода ${code} от API`);
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
    console.log(`✅ Данные для нового кода ${code} загружены: ${product.name} - ${product.packPrice || product.price} руб.`);

  } catch (error) {
    console.error(`❌ Ошибка при загрузке данных для кода ${code}:`, error);
  }
}

export async function updateAllPrices() {
  const startTime = Date.now();
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 НАЧАЛО ОБНОВЛЕНИЯ ЦЕН: ${new Date().toLocaleString()}`);
  console.log('='.repeat(60));

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    console.log(`📦 Всего кодов в базе: ${allCodes.length}`);

    const BATCH_SIZE = 100;
    const CONCURRENT_LIMIT = 3;
    
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`📊 Будет обработано ${batches.length} пачек по ${BATCH_SIZE} кодов`);
    console.log('-'.repeat(60));

    let processedBatches = 0;
    let totalProcessed = 0;
    let totalChanged = 0;
    let totalNewRecords = 0;
    let totalErrors = 0;

    const categoryStats = {};

    const processBatch = async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      const batchStartTime = new Date();
      
      console.log(`\n📤 [Пачка ${batchNum}/${batches.length}] Отправка ${batch.length} кодов...`);

      try {
        const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
          },
          body: JSON.stringify({
            ids: batch.map(code => parseInt(code)),
            isAdult: false,
            limit: BATCH_SIZE
          }),
          method: "POST"
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const products = data.data?.productCards || [];

        console.log(`📥 [Пачка ${batchNum}] Получено ${products.length} товаров`);

        if (products.length === 0) {
          console.log(`⚠️ [Пачка ${batchNum}] Нет данных от API`);
          return { processed: 0, changed: 0, newRecords: 0, errors: 0 };
        }

        const productsForPartlyPay = [];
        for (const product of products) {
          productsForPartlyPay.push({
            code: parseInt(product.code),
            price: parseFloat(product.packPrice || product.price)
          });
        }

        let partlyPayMap = {};
        if (productsForPartlyPay.length > 0) {
          try {
            const partlyPayResponse = await fetch("https://gate.21vek.by/partly-pay/v2/products.calculate", {
              method: "POST",
              headers: {
                "accept": "application/json",
                "content-type": "application/json"
              },
              body: JSON.stringify({ 
                data: { 
                  products: productsForPartlyPay 
                } 
              })
            });

            if (partlyPayResponse.ok) {
              const partlyPayResult = await partlyPayResponse.json();
              if (partlyPayResult.data) {
                partlyPayResult.data.forEach(item => {
                  partlyPayMap[item.code] = {
                    monthly_payment: item.monthly_payment,
                    no_overpayment_max_months: item.no_overpayment_max_months
                  };
                });
              }
            }
          } catch (error) {
            console.error(`❌ [Пачка ${batchNum}] Ошибка запроса рассрочки:`, error.message);
          }
        }

        let batchProcessed = 0;
        let batchChanged = 0;
        let batchNewRecords = 0;
        let batchErrors = 0;
        
        for (const product of products) {
          try {
            batchProcessed++;
            
            let category = 'Товары';
            if (product.categories && product.categories.length > 0) {
              category = product.categories[product.categories.length - 1].name;
            }
            
            if (!categoryStats[category]) {
              categoryStats[category] = { total: 0, changed: 0 };
            }
            categoryStats[category].total++;
            
            const today = new Date().toISOString().split('T')[0];
            
            const todayRecord = await db.execute({
              sql: `SELECT id FROM price_history 
                    WHERE product_code = ? AND DATE(updated_at) = ? 
                    LIMIT 1`,
              args: [product.code.toString(), today]
            });
            
            const lastRecord = await db.execute({
              sql: `SELECT price FROM price_history 
                    WHERE product_code = ? 
                    ORDER BY updated_at DESC LIMIT 1`,
              args: [product.code.toString()]
            });
            
            const lastPrice = lastRecord.rows[0]?.price;
            const currentPrice = parseFloat(product.packPrice || product.price);
            
            const isChanged = lastPrice !== undefined && Math.abs(currentPrice - lastPrice) > 0.01;
            
            if (isChanged) {
              batchChanged++;
              categoryStats[category].changed++;
              
              const changeSymbol = currentPrice > lastPrice ? '⬆️' : '⬇️';
              const changeValue = (currentPrice - lastPrice).toFixed(2);
              const changePercent = ((currentPrice - lastPrice) / lastPrice * 100).toFixed(1);
              
              console.log(`   ${changeSymbol} [${batchProcessed}/${products.length}] ${product.code}: ${lastPrice} → ${currentPrice} (${changeValue} руб, ${changePercent}%)`);
            }
            
            if (todayRecord.rows.length === 0) {
              batchNewRecords++;
            }
            
            const partlyInfo = partlyPayMap[parseInt(product.code)] || {};
            const productWithPartly = {
              ...product,
              monthly_payment: partlyInfo.monthly_payment,
              no_overpayment_max_months: partlyInfo.no_overpayment_max_months
            };
            
            await saveProductData(productWithPartly, batchStartTime);
            
          } catch (saveError) {
            batchErrors++;
            console.error(`   ❌ Ошибка сохранения товара ${product.code}:`, saveError.message);
          }
        }

        console.log(`✅ [Пачка ${batchNum}] Итог: обработано ${batchProcessed}, изменений: ${batchChanged}, новых записей: ${batchNewRecords}, ошибок: ${batchErrors}`);
        
        return { 
          processed: batchProcessed, 
          changed: batchChanged, 
          newRecords: batchNewRecords,
          errors: batchErrors 
        };

      } catch (error) {
        console.error(`❌ [Пачка ${batchNum}] Критическая ошибка:`, error.message);
        return { processed: 0, changed: 0, newRecords: 0, errors: batch.length };
      }
    };

    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      console.log(`\n🔄 Запуск группы из ${currentBatches.length} параллельных пачек`);
      
      const results = await Promise.all(
        currentBatches.map((batch, idx) => processBatch(batch, i + idx))
      );
      
      results.forEach(result => {
        totalProcessed += result.processed || 0;
        totalChanged += result.changed || 0;
        totalNewRecords += result.newRecords || 0;
        totalErrors += result.errors || 0;
      });
      
      processedBatches += currentBatches.length;
      
      const percentComplete = Math.round((processedBatches / batches.length) * 100);
      console.log(`\n📊 Прогресс: ${processedBatches}/${batches.length} пачек (${percentComplete}%)`);
      console.log(`   Обработано товаров: ${totalProcessed}, изменений: ${totalChanged}, ошибок: ${totalErrors}`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log(`🏁 **ОБНОВЛЕНИЕ ЗАВЕРШЕНО**`);
    console.log('='.repeat(60));
    console.log(`📊 **ИТОГОВАЯ СТАТИСТИКА**`);
    console.log('-'.repeat(40));
    console.log(`✅ Всего обработано: ${totalProcessed} товаров`);
    console.log(`🔄 Цены изменились: ${totalChanged} товаров`);
    console.log(`📝 Новых записей: ${totalNewRecords}`);
    console.log(`❌ Ошибок: ${totalErrors}`);
    console.log(`⏱️  Время выполнения: ${totalTime} сек`);
    
    // ========== ОТПРАВКА СТАТИСТИКИ АДМИНУ ==========
    let adminMessage = `📊 <b>ОБНОВЛЕНИЕ ЦЕН ЗАВЕРШЕНО</b>\n\n`;
    adminMessage += `📦 Всего товаров: ${totalProcessed}\n`;
    adminMessage += `🔄 Изменений: ${totalChanged}\n`;
    adminMessage += `📝 Новых записей: ${totalNewRecords}\n`;
    adminMessage += `❌ Ошибок: ${totalErrors}\n`;
    adminMessage += `⏱️ Время: ${totalTime} сек\n\n`;
    
    if (Object.keys(categoryStats).length > 0) {
      adminMessage += `📊 <b>Статистика по категориям:</b>\n`;
      
      const sortedCategories = Object.entries(categoryStats)
        .sort((a, b) => b[1].total - a[1].total);
      
      sortedCategories.forEach(([category, stats]) => {
        const changePercent = ((stats.changed / stats.total) * 100).toFixed(1);
        adminMessage += `\n<b>${category}:</b>\n`;
        adminMessage += `   📦 Всего: ${stats.total} товаров\n`;
        adminMessage += `   🔄 Изменений: ${stats.changed} (${changePercent}%)\n`;
      });
    }
    
    await sendTelegramMessage(adminMessage);
    // =================================================
    
    console.log('='.repeat(60));
    console.log(`🕐 Завершено: ${new Date().toLocaleString()}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ ГЛОБАЛЬНАЯ ОШИБКА ПРИ ОБНОВЛЕНИИ ЦЕН:');
    console.error(error);
    
    await sendTelegramMessage(`
⚠️ <b>Ошибка при массовом обновлении</b>

${error.message}

🕐 ${new Date().toLocaleString('ru-RU')}
`);
  }
}

export async function cleanOldRecords() {
  console.log('🧹 Очистка записей старше 90 дней...');
  try {
    const result = await db.execute({
      sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
      args: []
    });
    console.log(`✅ Удалено ${result.rowsAffected} старых записей`);
  } catch (err) {
    console.error('❌ Ошибка при очистке:', err);
  }
}

export async function sendWeeklyStats() {
  try {
    console.log('📊 Формирование недельной статистики...');
    
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
    console.log('✅ Недельная статистика отправлена');

  } catch (error) {
    console.error('❌ Ошибка при формировании статистики:', error);
  }
}
