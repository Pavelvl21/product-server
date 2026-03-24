import { config } from '../../../src/config/env.js';
import { sendMessage, editMessageText, editMessageReplyMarkup } from '../index.js';
import { checkRateLimit } from '../services/rateLimiter.js';
import { 
  getUser, createUser, updateUserEmail, updateUserStatus, lockUserSelection,
  getUserMonitoringProducts, addToAllowedEmails
} from '../services/userService.js';
import { getProductsFromServer, getPriceChanges } from '../services/productService.js';
import { formatHelpMessage, formatStatusMessage, formatProductFull, formatChangesList } from '../services/messageFormatter.js';
import { showCategoryList } from './callbackHandler.js';
import Logger from '../../../src/services/logger.js';

const ADMIN_CHAT_ID = config.TELEGRAM_CHAT_ID;

export async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  try {
    const user = await getUser(userId);

    // Скрытая команда для проверки админства
    if (text === '/isAdmin') {
      const isAdmin = (userId == ADMIN_CHAT_ID);
      await sendMessage(chatId, isAdmin ? '✅ Да' : '❌ Нет');
      return;
    }

    // Обработка команды /email
    if (text && text.startsWith('/email ')) {
      const email = text.replace('/email ', '').trim().toLowerCase();
      
      const emailRegex = /^[^\s@]+@([^\s@]+)$/;
      const match = email.match(emailRegex);
      
      if (!match) {
        await sendMessage(chatId, '❌ Неверный формат email');
        return;
      }
      
      const domain = match[1];
      
      if (domain !== 'patio-minsk.by') {
        await sendMessage(chatId, '❌ Разрешены только email с доменом @patio-minsk.by');
        return;
      }
      
      // Сохраняем email
      await updateUserEmail(userId, email);
      
      // Отправляем уведомление админу
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
          { text: '✅ Подтвердить регистрацию', callback_data: `confirm_reg_${userId}_${email}` },
          { text: '❌ Отклонить', callback_data: `reject_reg_${userId}` }
        ]]
      };
      
      await sendMessage(ADMIN_CHAT_ID, `🔔 Новая регистрация!\n\n${info}`, {
        reply_markup: keyboard
      });
      
      await sendMessage(chatId, '✅ Email сохранен. Ожидайте подтверждения администратора.');
      return;
    }

    // Обработка /start
    if (text === '/start') {
      const existingUser = await getUser(userId);

      if (!existingUser) {
        await createUser(userId, username, firstName, lastName, chatId, null);
        
        await sendMessage(chatId, 
          '👋 Добро пожаловать в Price Hunter!\n\n' +
          'Для регистрации отправьте ваш email с доменом @patio-minsk.by:\n' +
          '<code>/email ваш.email@patio-minsk.by</code>\n\n' +
          'После проверки администратор подтвердит регистрацию.'
        );
        return;
      }

      if (existingUser.status === 'approved') {
        if (!existingUser.selection_locked) {
          await showCategoryList(chatId, userId);
        } else {
          await sendMessage(chatId, 
            '👋 Добро пожаловать!\n\n' +
            '📋 <b>Команды:</b>\n' +
            '/changes - изменения цен\n' +
            '/status - статус\n' +
            '/help - помощь'
          );
        }
      } else if (existingUser.status === 'pending') {
        await sendMessage(chatId, '⏳ Ваш email ожидает подтверждения администратором.');
      } else if (existingUser.status === 'rejected') {
        await sendMessage(chatId, '❌ Ваша регистрация отклонена. Обратитесь к администратору.');
      } else {
        await sendMessage(chatId, '❌ Доступ запрещён');
      }
      return;
    }

    // Проверка статуса
    if (!user || user.status !== 'approved') {
      await sendMessage(chatId, '❌ Доступ запрещён');
      return;
    }

    // /status
    if (text === '/status') {
      if (!checkRateLimit(userId, '/status')) return;
      await sendMessage(chatId, formatStatusMessage(user));
      return;
    }

    // /changes
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

    // /help
    if (text === '/help') {
      await sendMessage(chatId, formatHelpMessage());
      return;
    }

    await sendMessage(chatId, '❓ Неизвестная команда. /help');
    
  } catch (err) {
    Logger.error('Ошибка обработки сообщения', err, { userId, command: text });
    await sendMessage(chatId, '❌ Произошла внутренняя ошибка');
  }
}