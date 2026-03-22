export const BOT_CONSTANTS = {
  // Состояния пользователей
  STATES: {
    IDLE: 'idle',
    SELECTING_CATEGORIES: 'selecting_categories'
  },
  
  // Лимиты rate limiting (мс)
  RATE_LIMITS: {
    '/changes': 5000,
    '/goods': 3000,
    '/status': 2000,
    'default': 1000
  },
  
  // Задержки
  MESSAGE_DELAY_MS: 100,
  BATCH_SIZE: 50
};