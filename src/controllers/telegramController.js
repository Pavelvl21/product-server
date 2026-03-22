import { handleTelegramUpdate } from '../bot/index.js';
import db from '../../database.js';
import Logger from '../services/logger.js';

export async function webhook(req, res, next) {
  try {
    await handleTelegramUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    Logger.error('Telegram webhook error', err);
    res.sendStatus(500);
  }
}

export async function getUsers(req, res, next) {
  try {
    const users = await db.execute(`
      SELECT telegram_id, username, first_name, last_name, status, selected_categories,
             requested_at, approved_at, approved_by, selection_locked, user_id
      FROM telegram_users
      ORDER BY requested_at DESC
    `);
    res.json(users.rows);
  } catch (err) {
    Logger.error('Ошибка получения пользователей Telegram', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}