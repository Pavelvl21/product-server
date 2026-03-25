import { config } from '../../../src/config/env.js';
import { sendMessage, editMessageText } from '../index.js';
import { checkRateLimit } from '../services/rateLimiter.js';
import { 
  getUser, createUser, updateUserEmail, updateUserStatus,
  getUserMonitoringProducts
} from '../services/userService.js';
import { getProductsFromServer, getPriceChanges } from '../services/productService.js';
import { formatHelpMessage, formatStatusMessage, formatChangesList } from '../services/messageFormatter.js';
import Logger from '../../../src/services/logger.js';

const ADMIN_CHAT_ID = config.TELEGRAM_CHAT_ID;

// Хранилище состояний пользователей
const userState = new Map(); // userId -> { state: 'awaiting_email' }

export async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  try {
    const user = await getUser(userId);

    // ==================== СКРЫТАЯ КОМАНДА ДЛЯ АДМИНА ====================
    if (text === '/isAdmin') {
      const isAdmin = (userId == ADMIN_CHAT_ID);
      await sendMessage(chatId, isAdmin ? '✅ Да' : '❌ Нет');
      return;
    }

    // ==================== КОМАНДА ДЛЯ АДМИНА: ОТПРАВКА ТЕСТОВОГО ПИСЬМА ====================
    if (text && text.startsWith('/smsg ')) {
      // Проверяем, что отправитель — админ
      if (userId != ADMIN_CHAT_ID) {
        await sendMessage(chatId, '⛔ Нет прав');
        return;
      }
      
      // Разбираем команду: /smsg email@example.com текст сообщения
      const parts = text.split(' ');
      if (parts.length < 3) {
        await sendMessage(chatId, 
          '❌ Неверный формат. Используйте:\n' +
          '<code>/smsg email@domain.com текст сообщения</code>\n\n' +
          'Пример: <code>/smsg user@patio-minsk.by Привет, это тест!</code>'
        );
        return;
      }
      
      const email = parts[1];
      const messageText = parts.slice(2).join(' ');
      
      // Простая валидация email
      const emailRegex = /^[^\s@]+@([^\s@]+)$/;
      if (!emailRegex.test(email)) {
        await sendMessage(chatId, '❌ Неверный формат email');
        return;
      }
      
      try {
        // Импортируем функцию отправки email
        const { sendEmail } = await import('../../../src/services/emailService.js');
        
        const subject = 'Тестовое сообщение от Price Hunter';
        const text = `
${messageText}

---
Это тестовое сообщение отправлено через бот Price Hunter.
        `;
        
        const result = await sendEmail(email, subject, text);
        
        if (result) {
          await sendMessage(chatId, `✅ Сообщение отправлено на ${email}`);
          Logger.info('Тестовое письмо отправлено админом', { email, messageText });
        } else {
          await sendMessage(chatId, `❌ Не удалось отправить сообщение на ${email}`);
        }
        
      } catch (err) {
        Logger.error('Ошибка отправки тестового письма', err, { email });
        await sendMessage(chatId, `❌ Ошибка при отправке: ${err.message}`);
      }
      
      return;
    }

    // ==================== ОБРАБОТКА ВВОДА EMAIL (после /start) ====================
    const state = userState.get(userId);
    if (state && state.state === 'awaiting_email' && text && !text.startsWith('/')) {
      const email = text.trim().toLowerCase();
      
      const emailRegex = /^[^\s@]+@([^\s@]+)$/;
      const match = email.match(emailRegex);
      
      if (!match) {
        await sendMessage(chatId, '❌ Неверный формат email. Попробуйте еще раз:\n\nНапример: <code>ivan@patio-minsk.by</code>');
        return;
      }
      
      const domain = match[1];
      
      if (domain !== 'patio-minsk.by') {
        await sendMessage(chatId, '❌ Разрешены только email с доменом @patio-minsk.by. Попробуйте еще раз:\n\nНапример: <code>ivan@patio-minsk.by</code>');
        return;
      }
      
      // Сохраняем email
      await updateUserEmail(userId, email);
      
      // Кодируем email для callback_data (убираем проблемные символы)
      const encodedEmail = Buffer.from(email).toString('base64').replace(/[+/=]/g, '');
      
      // Получаем информацию о пользователе
      const userInfo = await getUser(userId);
      const info = [
        `🆔 ID: <code>${userId}</code>`,
        `👤 Имя: ${userInfo.first_name || '—'}`,
        `📱 Username: ${userInfo.username ? '@' + userInfo.username : '—'}`,
        `📧 Email: <code>${email}</code>`,
        `💬 Chat ID: <code>${chatId}</code>`
      ].join('\n');
      
      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Подтвердить регистрацию', callback_data: `confirm_reg_${userId}_${encodedEmail}` },
          { text: '❌ Отклонить', callback_data: `reject_reg_${userId}` }
        ]]
      };
      
      await sendMessage(ADMIN_CHAT_ID, `🔔 Новая регистрация!\n\n${info}`, {
        reply_markup: keyboard
      });
      
      await sendMessage(chatId, '✅ Email сохранен. Ожидайте подтверждения администратора.');
      
      // Очищаем состояние
      userState.delete(userId);
      return;
    }

    // ==================== ОБРАБОТКА /START ====================
    if (text === '/start') {
      const existingUser = await getUser(userId);

      if (!existingUser) {
        // Создаём пользователя без email
        await createUser(userId, username, firstName, lastName, chatId, null);
        
        // Устанавливаем состояние ожидания email
        userState.set(userId, { state: 'awaiting_email' });
        
        await sendMessage(chatId, 
          '👋 Добро пожаловать в Price Hunter!\n\n' +
          'Для регистрации введите ваш email с доменом @patio-minsk.by:\n' +
          'Например: <code>ivan@patio-minsk.by</code>'
        );
        return;
      }

      if (existingUser.status === 'approved') {
        await sendMessage(chatId, 
          '👋 Добро пожаловать!\n\n' +
          '📋 <b>Команды:</b>\n' +
          '/changes - изменения цен\n' +
          '/status - статус\n' +
          '/help - помощь'
        );
      } else if (existingUser.status === 'pending') {
        await sendMessage(chatId, '⏳ Ваш email ожидает подтверждения администратором.');
      } else if (existingUser.status === 'rejected') {
        await sendMessage(chatId, '❌ Ваша регистрация отклонена. Обратитесь к администратору.');
      } else {
        await sendMessage(chatId, '❌ Доступ запрещён');
      }
      return;
    }

    // ==================== ПРОВЕРКА СТАТУСА ====================
    if (!user || user.status !== 'approved') {
      await sendMessage(chatId, '❌ Доступ запрещён');
      return;
    }

    // ==================== /STATUS ====================
    if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) return;
      await sendMessage(chatId, formatStatusMessage(user));
      return;
    }

    // ==================== /CHANGES ====================
    if (text === '/changes') {
      if (!checkRateLimit(userId, '/changes')) return;

      const monitoringCodes = await getUserMonitoringProducts(userId);
      
      if (monitoringCodes.length === 0) {
        await sendMessage(chatId, '📭 У вас нет товаров в мониторинге');
        return;
      }

      const loadingMsg = await sendMessage(chatId, '⏳ Загружаю изменения цен...');
      
      if (!loadingMsg || !loadingMsg.message_id) {
        return;
      }
      
      try {
        const allChanges = await getPriceChanges();
        const changes = allChanges.filter(c => monitoringCodes.includes(c.product_code));

        if (!changes.length) {
          await editMessageText(chatId, loadingMsg.message_id, '📭 Сегодня нет изменений по вашим товарам');
          return;
        }

        const message = formatChangesList(changes, '📊 ИЗМЕНЕНИЯ ЦЕН В МОНИТОРИНГЕ');
        await editMessageText(chatId, loadingMsg.message_id, message);
        
      } catch (err) {
        Logger.error('Ошибка при получении изменений', err, { userId });
        await editMessageText(chatId, loadingMsg.message_id, '❌ Произошла ошибка при загрузке изменений цен');
      }
      
      return;
    }

    // ==================== /HELP ====================
    if (text === '/help') {
      await sendMessage(chatId, formatHelpMessage());
      return;
    }

    // ==================== НЕИЗВЕСТНАЯ КОМАНДА ====================
    await sendMessage(chatId, '❓ Неизвестная команда. /help');
    
  } catch (err) {
    Logger.error('Ошибка обработки сообщения', err, { userId, command: text });
    await sendMessage(chatId, '❌ Произошла внутренняя ошибка');
  }
}