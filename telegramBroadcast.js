// telegramBroadcast.js
import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

async function sendMessage(chatId, text, options = {}) {
  if (!BOT_TOKEN) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

// ==================== ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЕЙ ====================

export async function getAllApprovedUsers() {
  try {
    const result = await db.execute({
      sql: 'SELECT telegram_id, chat_id, selected_categories FROM telegram_users WHERE status = ?',
      args: ['approved']
    });
    
    return result.rows.map(user => {
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
      } catch {
        user.selected_categories = [];
      }
      return user;
    });
  } catch (err) {
    console.error('❌ Ошибка получения пользователей:', err);
    return [];
  }
}

export async function getUsersByCategories(categories) {
  if (!categories || categories.length === 0) return [];
  
  try {
    const allUsers = await getAllApprovedUsers();
    return allUsers.filter(user => {
      const userCats = user.selected_categories || [];
      return userCats.some(cat => categories.includes(cat));
    });
  } catch (err) {
    console.error('❌ Ошибка фильтрации пользователей:', err);
    return [];
  }
}

export async function getSubscriberStats() {
  try {
    const users = await getAllApprovedUsers();
    
    const stats = {
      total: users.length,
      byCategory: {},
      usersWithoutCategories: 0
    };
    
    users.forEach(user => {
      const cats = user.selected_categories || [];
      if (cats.length === 0) {
        stats.usersWithoutCategories++;
      } else {
        cats.forEach(cat => {
          stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
        });
      }
    });
    
    return stats;
  } catch (err) {
    console.error('❌ Ошибка получения статистики:', err);
    return { total: 0, byCategory: {}, usersWithoutCategories: 0 };
  }
}

// ==================== РАССЫЛКА ====================

export async function broadcastToAll(text, options = {}, onProgress = null) {
  const users = await getAllApprovedUsers();
  
  console.log(`📣 Начинаем рассылку ${users.length} пользователям`);
  
  const results = {
    total: users.length,
    success: 0,
    failed: 0,
    blocked: 0,
    startTime: Date.now(),
    endTime: null,
    duration: null
  };
  
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    
    try {
      const sent = await sendMessage(user.chat_id, text, options);
      
      if (sent && sent.ok) {
        results.success++;
      } else {
        results.failed++;
        if (sent?.description?.includes('blocked')) {
          results.blocked++;
        }
      }
      
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: users.length,
          success: results.success,
          failed: results.failed,
          percent: Math.round(((i + 1) / users.length) * 100)
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 35));
      
    } catch (err) {
      console.error(`❌ Ошибка отправки пользователю ${user.telegram_id}:`, err);
      results.failed++;
    }
  }
  
  results.endTime = Date.now();
  results.duration = Math.round((results.endTime - results.startTime) / 1000);
  
  return results;
}

export async function broadcastToCategories(text, categories, options = {}) {
  const users = await getUsersByCategories(categories);
  
  if (users.length === 0) {
    return { total: 0, success: 0, failed: 0, categories };
  }
  
  const results = {
    total: users.length,
    success: 0,
    failed: 0,
    categories: categories,
    startTime: Date.now(),
    endTime: null,
    duration: null
  };
  
  for (const user of users) {
    try {
      const sent = await sendMessage(user.chat_id, text, options);
      if (sent && sent.ok) {
        results.success++;
      } else {
        results.failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 35));
    } catch (err) {
      console.error(`❌ Ошибка отправки пользователю ${user.telegram_id}:`, err);
      results.failed++;
    }
  }
  
  results.endTime = Date.now();
  results.duration = Math.round((results.endTime - results.startTime) / 1000);
  
  return results;
}

export async function sendTestMessage(text) {
  if (!ADMIN_CHAT_ID) return false;
  const result = await sendMessage(ADMIN_CHAT_ID, `🧪 <b>ТЕСТ</b>\n\n${text}`);
  return result?.ok || false;
}

// ==================== ФОРМАТИРОВАНИЕ ====================

export function formatBroadcastResults(results, type = 'all') {
  const lines = [
    '✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>',
    '════════════════════',
    ''
  ];
  
  if (type === 'categories' && results.categories) {
    lines.push(`📁 <b>Категории:</b> ${results.categories.join(', ')}`);
  }
  
  lines.push(
    `👥 <b>Всего:</b> ${results.total}`,
    `✅ <b>Успешно:</b> ${results.success}`,
    `❌ <b>Ошибок:</b> ${results.failed}`,
    `🚫 <b>Заблокировали:</b> ${results.blocked || 0}`,
    ''
  );
  
  if (results.duration) {
    lines.push(`⏱ <b>Время:</b> ${results.duration} сек.`);
  }
  
  if (results.success > 0) {
    const percent = Math.round((results.success / results.total) * 100);
    lines.push(`📊 <b>Доставляемость:</b> ${percent}%`);
  }
  
  return lines.join('\n');
}

export function formatSubscriberStats(stats) {
  const lines = [
    '📊 <b>СТАТИСТИКА ПОДПИСЧИКОВ</b>',
    '══════════════════════',
    '',
    `👥 <b>Всего:</b> ${stats.total}`,
    `📭 <b>Без категорий:</b> ${stats.usersWithoutCategories}`,
    ''
  ];
  
  if (Object.keys(stats.byCategory).length > 0) {
    lines.push('<b>По категориям:</b>');
    
    const sorted = Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1]);
    
    sorted.forEach(([cat, count]) => {
      const percent = Math.round((count / stats.total) * 100);
      lines.push(`  • ${cat}: ${count} (${percent}%)`);
    });
  }
  
  return lines.join('\n');
}

// ==================== УВЕДОМЛЕНИЯ ОБ ИЗМЕНЕНИЯХ ЦЕН ====================

export async function notifyPriceChange(product, oldPrice, newPrice, formatFunction) {
  // Получаем категорию товара
  const category = product.category;
  if (!category) return 0;
  
  // Находим пользователей, подписанных на эту категорию
  const users = await getUsersByCategories([category]);
  if (users.length === 0) return 0;
  
  // Форматируем сообщение
  const message = formatFunction(product, oldPrice, newPrice);
  
  console.log(`💰 Уведомляем ${users.length} пользователей об изменении цены ${product.code} в категории "${category}"`);
  
  let sentCount = 0;
  for (const user of users) {
    try {
      await sendMessage(user.chat_id, message);
      sentCount++;
      await new Promise(resolve => setTimeout(resolve, 35));
    } catch (err) {
      console.error(`❌ Ошибка уведомления пользователя ${user.telegram_id}:`, err);
    }
  }
  
  return sentCount;
}
