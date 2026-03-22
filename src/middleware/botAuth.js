import { config } from '../config/env.js';
import Logger from '../services/logger.js';

export function authenticateBot(req, res, next) {
  const botKey = req.headers['x-bot-key'];
  
  if (!botKey || botKey !== config.SECRET_KEY) {
    Logger.warn('Попытка доступа бота с неверным ключом', { ip: req.ip });
    return res.status(403).json({ error: 'Доступ запрещен' });
  }
  
  next();
}