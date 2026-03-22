import { config } from '../../../src/config/env.js';
import { sendMessage } from '../index.js';
import { getUser, updateUserStatus } from '../services/userService.js';
import { showCategoryList } from './callbackHandler.js';
import { getAdminUserKeyboard } from '../keyboards.js';
import Logger from '../../../src/services/logger.js';

const ADMIN_CHAT_ID = config.TELEGRAM_CHAT_ID;

export async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  try {
    const info = [
      `🆔 ID: <code>${userId}</code>`,
      `👤 Имя: ${firstName || '—'}`,
      `📱 Username: ${username ? '@' + username : '—'}`,
      `💬 Chat ID: <code>${chatId}</code>`
    ].join('\n');

    const keyboard = getAdminUserKeyboard(userId);

    await sendMessage(ADMIN_CHAT_ID, `🔔 Новый пользователь!\n\n${info}`, {
      reply_markup: keyboard
    });
  } catch (err) {
    Logger.error('Ошибка уведомления админа', err);
  }
}

export async function handleAdminCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  if (fromId != ADMIN_CHAT_ID) {
    return false;
  }

  try {
    if (data.startsWith('approve_')) {
      const userId = data.replace('approve_', '');
      const targetUser = await getUser(userId);
      
      if (!targetUser) return false;

      await updateUserStatus(userId, 'approved', 'admin');
      
      await sendMessage(targetUser.chat_id, 
        '✅ <b>Ваш запрос одобрен!</b>\n\n' +
        'Теперь выберите категории товаров для отслеживания:'
      );
      
      await showCategoryList(targetUser.chat_id, userId);
      return true;
    }

    if (data.startsWith('reject_')) {
      const userId = data.replace('reject_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'rejected', 'admin');
        
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '⛔ <b>Доступ отклонён</b>');
        }
      }
      return true;
    }

    if (data.startsWith('block_')) {
      const userId = data.replace('block_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'blocked', 'admin');
        
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '🚫 <b>Вы заблокированы</b>');
        }
      }
      return true;
    }

    return false;
  } catch (err) {
    Logger.error('Ошибка обработки админ callback', err);
    return false;
  }
}