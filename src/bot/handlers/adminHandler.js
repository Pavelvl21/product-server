import bcrypt from 'bcrypt';
import db from '../../../database.js';
import { sendMessage, editMessageReplyMarkup, answerCallback } from '../index.js';
import { getUser, updateUserStatus, addToAllowedEmails } from '../services/userService.js';
import { sendRegistrationLink } from '../../../src/services/emailService.js';
import Logger from '../../../src/services/logger.js';

const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  try {
    const info = [
      `🆔 ID: <code>${userId}</code>`,
      `👤 Имя: ${firstName || '—'}`,
      `📱 Username: ${username ? '@' + username : '—'}`,
      `💬 Chat ID: <code>${chatId}</code>`
    ].join('\n');

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Разрешить', callback_data: `approve_${userId}` },
        { text: '❌ Отклонить', callback_data: `reject_${userId}` },
        { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
      ]]
    };

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
    await answerCallback(query.id, '⛔ Нет прав');
    return false;
  }

  try {
    // ==================== ПОДТВЕРЖДЕНИЕ РЕГИСТРАЦИИ (с email) ====================
    if (data.startsWith('confirm_reg_')) {
      const parts = data.split('_');
      const userId = parseInt(parts[2]);
      const encodedEmail = parts.slice(3).join('_');
      const email = Buffer.from(encodedEmail, 'base64').toString();
      
      const targetUser = await getUser(userId);
      
      if (!targetUser) {
        await answerCallback(query.id, '❌ Пользователь не найден');
        return false;
      }
      
      // 1. Обновляем статус в telegram_users
      await updateUserStatus(userId, 'approved', 'admin');
      
      // 2. Добавляем email в белый список allowed_emails
      await addToAllowedEmails(email);
      
      // 3. Проверяем, существует ли пользователь в таблице users
      const existingUser = await db.execute({
        sql: 'SELECT id FROM users WHERE username = ?',
        args: [email]
      });
      
      let userId_db = null;
      
      if (existingUser.rows.length === 0) {
        // Создаём пользователя без пароля (пустой пароль)
        const newUser = await db.execute({
          sql: `INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id`,
          args: [email, '']
        });
        
        userId_db = newUser.rows[0].id;
        
        // Сохраняем telegram_id в таблицу users
        await db.execute({
          sql: 'UPDATE users SET telegram_id = ? WHERE id = ?',
          args: [userId, userId_db]
        });
        
        // Отправляем письмо со ссылкой на регистрацию
        await sendRegistrationLink(email);
        
        // Отправляем уведомление в Telegram
        await sendMessage(targetUser.chat_id, 
          `✅ <b>Регистрация подтверждена!</b>\n\n` +
          `📧 На ваш email <code>${email}</code> отправлена ссылка для завершения регистрации.\n\n` +
          `🔗 Перейдите по ссылке, чтобы создать пароль.\n\n` +
          `📋 <b>Команды бота:</b>\n` +
          `/changes - изменения цен\n` +
          `/status - статус\n` +
          `/help - помощь`
        );
      } else {
        userId_db = existingUser.rows[0].id;
        
        await db.execute({
          sql: 'UPDATE users SET telegram_id = ? WHERE id = ?',
          args: [userId, userId_db]
        });
        
        await sendMessage(targetUser.chat_id, 
          `✅ <b>Регистрация подтверждена!</b>\n\n` +
          `Ваш email: <code>${email}</code>\n` +
          `Вы уже зарегистрированы на сайте. Используйте свой пароль для входа.\n\n` +
          `🔗 <a href="https://price-hunter-bel.vercel.app/login">Войти на сайт</a>\n\n` +
          `📋 <b>Команды бота:</b>\n` +
          `/changes - изменения цен\n` +
          `/status - статус\n` +
          `/help - помощь`
        );
      }
      
      // 4. Привязываем telegram_users к users
      await db.execute({
        sql: 'UPDATE telegram_users SET user_id = ? WHERE telegram_id = ?',
        args: [userId_db, userId]
      });
      
      // 5. Редактируем сообщение админа
      await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });
      
      await answerCallback(query.id, '✅ Регистрация подтверждена');
      return true;
    }
    
    // ==================== ОТКЛОНЕНИЕ РЕГИСТРАЦИИ ====================
    if (data.startsWith('reject_reg_')) {
      const userId = parseInt(data.replace('reject_reg_', ''));
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'rejected', 'admin');
        
        await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });
        
        await sendMessage(targetUser.chat_id, 
          '❌ <b>Ваша регистрация отклонена.</b>\n\n' +
          'Если вы считаете, что это ошибка, обратитесь к администратору.'
        );
      }
      
      await answerCallback(query.id, '❌ Регистрация отклонена');
      return true;
    }
    
    // ==================== ОБРАТНАЯ СОВМЕСТИМОСТЬ (старые кнопки) ====================
    if (data.startsWith('approve_')) {
      const userId = data.replace('approve_', '');
      const targetUser = await getUser(userId);
      
      if (!targetUser) return false;
      
      await updateUserStatus(userId, 'approved', 'admin');
      
      await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });
      
      await sendMessage(targetUser.chat_id, 
        '✅ <b>Ваш запрос одобрен!</b>\n\n' +
        '📋 <b>Команды:</b>\n' +
        '/changes - изменения цен\n' +
        '/status - статус\n' +
        '/help - помощь'
      );
      
      await answerCallback(query.id, '✅ Подтверждено');
      return true;
    }
    
    if (data.startsWith('reject_')) {
      const userId = data.replace('reject_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'rejected', 'admin');
        
        await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });
        
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '⛔ <b>Доступ отклонён</b>');
        }
      }
      
      await answerCallback(query.id, '❌ Отклонено');
      return true;
    }
    
    if (data.startsWith('block_')) {
      const userId = data.replace('block_', '');
      const targetUser = await getUser(userId);
      
      if (targetUser) {
        await updateUserStatus(userId, 'blocked', 'admin');
        
        await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });
        
        if (targetUser.chat_id) {
          await sendMessage(targetUser.chat_id, '🚫 <b>Вы заблокированы</b>');
        }
      }
      
      await answerCallback(query.id, '🚫 Заблокировано');
      return true;
    }
    
    return false;
    
  } catch (err) {
    Logger.error('Ошибка обработки админ callback', err);
    await answerCallback(query.id, '❌ Произошла ошибка');
    return false;
  }
}