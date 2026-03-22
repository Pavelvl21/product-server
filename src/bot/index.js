import { config } from '../config/env.js';
import { handleMessage } from './handlers/messageHandler.js';
import { handleCallback } from './handlers/callbackHandler.js';
import { handleAdminCallback } from './handlers/adminHandler.js';
import Logger from '../services/logger.js';

const BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = config.TELEGRAM_CHAT_ID;

// Проверка наличия токена
if (!BOT_TOKEN) {
  Logger.error('TELEGRAM_BOT_TOKEN не задан в переменных окружения');
}

/**
 * Отправка сообщения в Telegram
 * @param {number} chatId - ID чата
 * @param {string} text - Текст сообщения
 * @param {object} options - Дополнительные опции (reply_markup, etc)
 * @returns {Promise<object|boolean>}
 */
export async function sendMessage(chatId, text, options = {}) {
  if (!BOT_TOKEN) {
    Logger.error('Невозможно отправить сообщение: BOT_TOKEN не задан');
    return false;
  }
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      })
    });
    
    const result = await response.json();
    
    if (!result.ok) {
      Logger.error('Telegram API ошибка', null, { description: result.description });
    }
    
    return result;
  } catch (err) {
    Logger.error('Ошибка отправки сообщения', err, { chatId });
    return false;
  }
}

/**
 * Отправка сообщения администратору
 * @param {string} message - Текст сообщения
 * @returns {Promise<object|boolean>}
 */
export async function sendTelegramMessage(message) {
  if (!ADMIN_CHAT_ID) {
    Logger.warn('TELEGRAM_CHAT_ID не задан, уведомления админу не будут работать');
    return false;
  }
  return await sendMessage(ADMIN_CHAT_ID, message);
}

/**
 * Редактирование клавиатуры у существующего сообщения
 * @param {number} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {object} replyMarkup - Новая клавиатура
 */
export async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  if (!BOT_TOKEN) return;
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup
      })
    });
  } catch (err) {
    Logger.error('Ошибка редактирования клавиатуры', err, { chatId, messageId });
  }
}

/**
 * Ответ на callback запрос (убирает "часики" у кнопки)
 * @param {string} callbackId - ID callback запроса
 * @param {string} text - Текст уведомления
 * @param {boolean} showAlert - Показывать alert или нет
 */
export async function answerCallback(callbackId, text, showAlert = false) {
  if (!BOT_TOKEN) return;
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: text,
        show_alert: showAlert
      })
    });
  } catch (err) {
    Logger.error('Ошибка ответа на callback', err, { callbackId });
  }
}

/**
 * Главный обработчик обновлений от Telegram
 * @param {object} update - Объект обновления от Telegram
 */
export async function handleTelegramUpdate(update) {
  try {
    // Обработка обычных сообщений
    if (update.message) {
      await handleMessage(update.message);
    }
    
    // Обработка callback запросов (нажатия на кнопки)
    if (update.callback_query) {
      // Сначала пробуем обработать как админский callback
      const isAdminHandled = await handleAdminCallback(update.callback_query);
      
      // Если не админский, обрабатываем как обычный
      if (!isAdminHandled) {
        await handleCallback(update.callback_query);
      }
    }
  } catch (err) {
    Logger.error('Критическая ошибка в обработчике обновлений', err);
  }
}

/**
 * Редактирование текста существующего сообщения
 * @param {number} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} text - Новый текст
 * @param {object} options - Дополнительные опции
 * @returns {Promise<object|boolean>}
 */
export async function editMessageText(chatId, messageId, text, options = {}) {
  if (!BOT_TOKEN) return false;
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      })
    });
    
    return await response.json();
  } catch (err) {
    Logger.error('Ошибка редактирования сообщения', err, { chatId, messageId });
    return false;
  }
}

/**
 * Отправка действия (typing, upload_photo, etc.)
 * @param {number} chatId - ID чата
 * @param {string} action - Действие (typing, upload_photo, etc.)
 */
export async function sendChatAction(chatId, action = 'typing') {
  if (!BOT_TOKEN) return;
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: action
      })
    });
  } catch (err) {
    Logger.error('Ошибка отправки действия', err, { chatId, action });
  }
}

// Экспорт для обратной совместимости со старым кодом
export { handleTelegramUpdate as default };
export { formatChangesList } from './services/messageFormatter.js';
export { editMessageText, sendChatAction };