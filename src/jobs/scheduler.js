import cron from 'node-cron';
import { CONSTANTS } from '../config/constants.js';
import { updateAllPrices, cleanOldRecords } from '../../priceUpdater.js';
import { sendWeeklyStats } from '../../priceUpdater.js';
import Logger from '../services/logger.js';

export function startScheduler() {
  // Обновление цен по расписанию
  CONSTANTS.PRICE_UPDATE_SCHEDULES.forEach(cronTime => {
    cron.schedule(cronTime, () => {
      Logger.info(`Запуск обновления по расписанию ${cronTime}`);
      updateAllPrices().catch(err => {
        Logger.error('Ошибка в запланированном обновлении', err);
      });
    });
  });
  
  // Очистка старых записей
  cron.schedule(CONSTANTS.CLEANUP_SCHEDULE, () => {
    Logger.info('Запуск плановой очистки');
    cleanOldRecords().catch(err => {
      Logger.error('Ошибка при очистке', err);
    });
  });
  
  // Еженедельная статистика
  cron.schedule(CONSTANTS.WEEKLY_STATS_SCHEDULE, () => {
    Logger.info('Запуск формирования недельной статистики');
    sendWeeklyStats().catch(err => {
      Logger.error('Ошибка при формировании статистики', err);
    });
  });
  
  // Первый запуск после старта
  setTimeout(() => {
    Logger.info('Запуск первого обновления после старта сервера');
    updateAllPrices().catch(err => {
      Logger.error('Ошибка при первом обновлении', err);
    });
    cleanOldRecords().catch(err => {
      Logger.error('Ошибка при первой очистке', err);
    });
  }, 10000);
}