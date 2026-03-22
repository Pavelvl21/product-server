import Logger from '../../services/logger.js';

/**
 * Коллектор уведомлений об изменениях цен
 * Накопливает уведомления и отправляет их пакетно после завершения обновления
 */
class NotificationCollector {
  constructor() {
    this.notifications = new Map(); // userId -> { chatId, changes: [] }
    this.updateInProgress = false;
    this.timeout = null;
  }
  
  /**
   * Добавить уведомление для пользователя
   * @param {number} userId - ID пользователя
   * @param {number} chatId - Chat ID для отправки
   * @param {object} notification - Данные об изменении
   */
  addNotification(userId, chatId, notification) {
    if (!this.notifications.has(userId)) {
      this.notifications.set(userId, { chatId, changes: [] });
    }
    
    const userNotifications = this.notifications.get(userId);
    userNotifications.changes.push(notification);
    
    Logger.debug('Добавлено уведомление', { userId, total: userNotifications.changes.length });
  }
  
  /**
   * Начать сессию обновления
   */
  startUpdate() {
    this.updateInProgress = true;
    
    // Сбрасываем предыдущий таймаут
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    
    // Устанавливаем таймаут на случай, если обновление не завершится
    this.timeout = setTimeout(() => {
      if (this.updateInProgress) {
        Logger.warn('Таймаут обновления, отправляем накопленные уведомления');
        this.flush();
      }
    }, 30000); // 30 секунд
  }
  
  /**
   * Завершить сессию обновления и отправить все накопленные уведомления
   */
  finishUpdate() {
    this.updateInProgress = false;
    
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    
    this.flush();
  }
  
  /**
   * Отправить все накопленные уведомления
   */
  async flush() {
    if (this.notifications.size === 0) {
      return;
    }
    
    Logger.info(`Отправка ${this.notifications.size} пакетов уведомлений`);
    
    // Импортируем динамически, чтобы избежать циклических зависимостей
    const { sendMessage } = await import('../bot/index.js');
    const { formatChangesList } = await import('../bot/services/messageFormatter.js');
    
    for (const [userId, data] of this.notifications.entries()) {
      const { chatId, changes } = data;
      
      if (changes.length === 0) continue;
      
      // Сортируем изменения (повышения сверху, снижения снизу, по убыванию)
const sortedChanges = [...changes].sort((a, b) => {
  // Сначала по типу (повышения выше)
  if (a.isDecrease !== b.isDecrease) {
    return a.isDecrease ? 1 : -1;
  }
  // Внутри группы: по абсолютному значению изменения
  if (!a.isDecrease) {
    // Повышения: от большего к меньшему
    return b.change - a.change;
  } else {
    // Снижения: от большего к меньшему по модулю (самое сильное снижение внизу)
    return Math.abs(a.change) - Math.abs(b.change);
  }
});
      
      const message = formatChangesList(sortedChanges, '🔔 ИЗМЕНЕНИЯ В ВАШЕМ МОНИТОРИНГЕ');
      
      try {
        await sendMessage(chatId, message);
        Logger.info('Уведомление отправлено', { userId, changesCount: changes.length });
      } catch (err) {
        Logger.error('Ошибка отправки уведомления', err, { userId });
      }
    }
    
    // Очищаем коллектор
    this.notifications.clear();
  }
  
  /**
   * Проверить, идет ли обновление
   */
  isUpdateInProgress() {
    return this.updateInProgress;
  }
}

// Создаем единственный экземпляр коллектора
export const notificationCollector = new NotificationCollector();