import app from './src/app.js';
import { config } from './src/config/env.js';
import { initTables } from './database.js';
import { startScheduler } from './src/jobs/scheduler.js';
import Logger from './src/services/logger.js';

const PORT = config.PORT;

// Инициализация БД
await initTables();

// Запуск планировщика задач
startScheduler();

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  Logger.info(`Сервер запущен на порту ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  Logger.info('SIGTERM сигнал получен, завершаем работу');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  Logger.error('Непойманное исключение', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  Logger.error('Необработанный rejection', err);
  process.exit(1);
});