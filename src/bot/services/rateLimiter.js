import { BOT_CONSTANTS } from '../constants.js';

const userLastCommand = new Map();

export function checkRateLimit(userId, command) {
  const key = `${userId}_${command}`;
  const now = Date.now();
  const lastTime = userLastCommand.get(key) || 0;
  
  const limit = BOT_CONSTANTS.RATE_LIMITS[command] || BOT_CONSTANTS.RATE_LIMITS.default;
  
  if (now - lastTime < limit) {
    return false;
  }
  
  userLastCommand.set(key, now);
  
  // Очистка старых записей
  const oldKeys = [...userLastCommand.keys()].filter(k => now - userLastCommand.get(k) > 60000);
  oldKeys.forEach(k => userLastCommand.delete(k));
  
  return true;
}