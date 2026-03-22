import { config } from '../config/env.js';
import { handleMessage } from './handlers/messageHandler.js';
import { handleCallback } from './handlers/callbackHandler.js';
import { handleAdminCallback } from './handlers/adminHandler.js';
import Logger from '../services/logger.js';

const BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;

export async function sendMessage(chatId, text, options = {}) {
  if (!BOT_TOKEN) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
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
    return await res.json();
  } catch (err) {
    Logger.error('Ошибка отправки сообщения', err);
    return false;
  }
}

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
    Logger.error('Ошибка редактирования клавиатуры', err);
  }
}

export async function answerCallback(callbackId, text) {
  if (!BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: text,
        show_alert: false
      })
    });
  } catch (err) {
    Logger.error('Ошибка ответа на callback', err);
  }
}

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) {
      await handleMessage(update.message);
    }
    if (update.callback_query) {
      const isAdminHandled = await handleAdminCallback(update.callback_query);
      if (!isAdminHandled) {
        await handleCallback(update.callback_query);
      }
    }
  } catch (err) {
    Logger.error('Критическая ошибка в обработчике обновлений', err);
  }
}