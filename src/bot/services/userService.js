import db from '../../../database.js';
import Logger from '../../../src/services/logger.js';

export async function getUser(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories, selection_locked, user_id, email FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
      } catch {
        user.selected_categories = [];
      }
      return user;
    }
    return null;
  } catch (err) {
    Logger.error('Ошибка получения пользователя', err, { telegramId });
    return null;
  }
}

export async function createUser(telegramId, username, firstName, lastName, chatId, email = null) {
  try {
    await db.execute({
      sql: `INSERT INTO telegram_users 
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories, selection_locked, email)
            VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?, ?)`,
      args: [telegramId, username || '', firstName || '', lastName || '', chatId, false, email]
    });
    
    Logger.info('Создан пользователь бота', { telegramId, username, email });
    return true;
  } catch (err) {
    Logger.error('Ошибка создания пользователя', err, { telegramId });
    return false;
  }
}

export async function updateUserEmail(telegramId, email) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET email = ? WHERE telegram_id = ?',
      args: [email, telegramId]
    });
    return true;
  } catch (err) {
    Logger.error('Ошибка обновления email', err, { telegramId });
    return false;
  }
}

export async function updateUserStatus(telegramId, status, approvedBy = null) {
  try {
    const approvedAt = status === 'approved' ? new Date().toISOString() : null;
    await db.execute({
      sql: `UPDATE telegram_users 
            SET status = ?, 
                approved_at = ?,
                approved_by = ?
            WHERE telegram_id = ?`,
      args: [status, approvedAt, approvedBy, telegramId]
    });
    return true;
  } catch (err) {
    Logger.error('Ошибка обновления статуса', err, { telegramId });
    return false;
  }
}

export async function addToAllowedEmails(email) {
  try {
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });
    return true;
  } catch (err) {
    Logger.error('Ошибка добавления email в белый список', err, { email });
    return false;
  }
}

export async function updateUserCategories(telegramId, categories) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
    return true;
  } catch (err) {
    Logger.error('Ошибка обновления категорий', err, { telegramId });
    return false;
  }
}

export async function lockUserSelection(telegramId) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selection_locked = ? WHERE telegram_id = ?',
      args: [true, telegramId]
    });
    return true;
  } catch (err) {
    Logger.error('Ошибка блокировки выбора', err, { telegramId });
    return false;
  }
}

export async function getUserMonitoringProducts(telegramId) {
  try {
    const telegramUser = await db.execute({
      sql: 'SELECT user_id FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    
    if (telegramUser.rows.length === 0) return [];
    
    const userId = telegramUser.rows[0].user_id;
    if (!userId) return [];
    
    const monitoringResult = await db.execute({
      sql: 'SELECT product_code FROM user_shelf WHERE user_id = ?',
      args: [userId]
    });
    
    return monitoringResult.rows.map(row => row.product_code);
  } catch (err) {
    Logger.error('Ошибка получения товаров мониторинга', err, { telegramId });
    return [];
  }
}