# Telegram Bot

Модульный Telegram бот на Node.js.

## 📁 Структура проекта

```
telegram/
├── index.js                    # основной файл, собирает всё вместе
├── bot.js                      # инициализация бота, webhook
├── handlers/
│   ├── messageHandler.js       # основной обработчик сообщений
│   ├── callbackHandler.js      # обработчик callback запросов
│   └── commandHandlers.js      # обработчики конкретных команд
├── services/
│   ├── userService.js          # работа с пользователями (БД)
│   ├── productService.js       # работа с товарами (API)
│   ├── categoryService.js      # работа с категориями
│   └── broadcastService.js     # рассылки (импорт из telegramBroadcast)
├── utils/
│   ├── logger.js               # цветное логирование
│   ├── rateLimiter.js          # rate limiting
│   ├── formatters.js           # форматирование сообщений
│   └── telegramApi.js          # отправка сообщений, callback ответы
└── config/
    └── constants.js            # константы, лимиты
```
