import db from '../../../database.js';
import { sendMessage, editMessageReplyMarkup, answerCallback } from '../index.js';
import { 
  getUser, updateUserCategories, lockUserSelection 
} from '../services/userService.js';
import { getCategoryKeyboard, getFinishKeyboard, getSuccessKeyboard } from '../keyboards.js';
import Logger from '../../../src/services/logger.js';
import { BOT_CONSTANTS } from '../constants.js';

export async function showCategoryList(chatId, userId) {
  try {
    const categories = await getCategoriesFromServer();
    if (!categories.length) {
      await sendMessage(chatId, '📭 Категории временно недоступны');
      return;
    }

    await sendMessage(chatId, 
      '📋 <b>Доступные категории</b>\n\n' +
      'Нажимайте на кнопки под каждой категорией, чтобы добавить её в свой список.\n' +
      'После выбора всех нужных категорий нажмите "✅ Завершить выбор".'
    );

    for (const category of categories) {
      const keyboard = getCategoryKeyboard(userId, category);
      await sendMessage(chatId, `📌 <b>${category}</b>`, { reply_markup: keyboard });
      await new Promise(resolve => setTimeout(resolve, BOT_CONSTANTS.MESSAGE_DELAY_MS));
    }

    const finishKeyboard = getFinishKeyboard(userId);
    await sendMessage(chatId, '✅ Когда выберете все нужные категории, нажмите кнопку ниже:', { reply_markup: finishKeyboard });
  } catch (err) {
    Logger.error('Ошибка показа категорий', err);
    await sendMessage(chatId, '❌ Произошла ошибка при загрузке категорий');
  }
}

async function getCategoriesFromServer() {
  try {
    const response = await fetch(`${process.env.API_URL || 'http://localhost:3000'}/api/public/categories`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.categories || [];
  } catch (err) {
    Logger.error('Ошибка получения категорий с сервера', err);
    return [];
  }
}

export async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  try {
    // Добавление категории
    if (data.startsWith('add_cat_')) {
      const parts = data.split('_');
      const userId = parseInt(parts[2]);
      const category = parts.slice(3).join('_');

      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser || currentUser.selection_locked) {
        await answerCallback(query.id, '❌ Выбор уже завершён');
        return;
      }

      const selected = currentUser.selected_categories || [];
      
      if (selected.includes(category)) {
        await answerCallback(query.id, '⚠️ Уже выбрано');
        return;
      }

      const updated = [...selected, category];
      await updateUserCategories(fromId, updated);

      await editMessageReplyMarkup(msg.chat.id, msg.message_id, getSuccessKeyboard());
      await answerCallback(query.id, `✅ ${category} добавлена`);
      return;
    }

    // Завершение выбора
    if (data.startsWith('finish_selection_')) {
      const userId = parseInt(data.replace('finish_selection_', ''));
      
      if (userId !== fromId) {
        await answerCallback(query.id, '⛔ Это не ваша сессия');
        return;
      }

      const currentUser = await getUser(fromId);
      if (!currentUser || currentUser.selection_locked) {
        await answerCallback(query.id, '❌ Выбор уже завершён');
        return;
      }

      const selected = currentUser.selected_categories || [];
      if (selected.length === 0) {
        await answerCallback(query.id, '⚠️ Выберите хотя бы одну категорию');
        return;
      }

      await lockUserSelection(fromId);
      await editMessageReplyMarkup(msg.chat.id, msg.message_id, { inline_keyboard: [] });

      await sendMessage(msg.chat.id, 
        '✅ <b>Выбор завершён!</b>\n\n' +
        selected.map(c => `• ${c}`).join('\n') + `\n\n` +
        'Теперь вам доступны команды:\n' +
        '/goods - список товаров\n' +
        '/changes - изменения цен'
      );

      await answerCallback(query.id, '✅ Выбор завершён');
      return;
    }

    if (data === 'noop') {
      await answerCallback(query.id, '✅');
      return;
    }

    await answerCallback(query.id, '❓ Неизвестная команда');
    
  } catch (err) {
    Logger.error('Ошибка обработки callback', err, { data, fromId });
    await answerCallback(query.id, '❌ Произошла ошибка');
  }
}