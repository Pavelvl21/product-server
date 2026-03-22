import { config } from "../../../src/config/env.js";
import { sendMessage } from "../index.js";
import { checkRateLimit } from "../services/rateLimiter.js";
import {
  getUser,
  createUser,
  updateUserStatus,
  lockUserSelection,
  getUserMonitoringProducts,
} from "../services/userService.js";
import {
  getProductsFromServer,
  getPriceChanges,
} from "../services/productService.js";
import {
  formatHelpMessage,
  formatStatusMessage,
  formatProductFull,
} from "../services/messageFormatter.js";
import { showCategoryList } from "./callbackHandler.js";
import { notifyAdminAboutNewUser } from "./adminHandler.js";
import Logger from "../../../src/services/logger.js";
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
    if (text === "/isAdmin") {
      const isAdmin = userId == ADMIN_CHAT_ID;
      await sendMessage(chatId, isAdmin ? "✅ Да" : "❌ Нет");
      return;
    }
    // Команды админа
    if (userId == ADMIN_CHAT_ID && text === "/help_broadcast") {
      await sendMessage(
        chatId,
        "📢 <b>Команды для рассылки</b>\n\n" +
          "<b>/broadcast текст</b> - отправить всем\n" +
          "<b>/broadcast_cat кат1,кат2 текст</b> - по категориям\n" +
          "<b>/test_broadcast текст</b> - тест (только админу)\n" +
          "<b>/stats</b> - статистика подписчиков\n" +
          "<b>/help_broadcast</b> - это сообщение\n\n" +
          "📌 <i>Задержка 35мс между сообщениями</i>",
      );
      return;
    }
    // Обработка /start
    if (text === "/start") {
      if (!user) {
        await createUser(userId, username, firstName, lastName, chatId);
        if (ADMIN_CHAT_ID) {
          await notifyAdminAboutNewUser(userId, username, firstName, chatId);
        }
        await sendMessage(
          chatId,
          "⏳ Запрос отправлен администратору. Ожидайте.",
        );
        return;
      }
      if (user.status === "approved") {
        if (!user.selection_locked) {
          await showCategoryList(chatId, userId);
        } else {
          await sendMessage(
            chatId,
            "👋 Добро пожаловать!\n\n" +
              "📋 <b>Команды:</b>\n" +
              "/goods - список товаров\n" +
              "/changes - изменения цен\n" +
              "/status - статус\n" +
              "/help - помощь",
          );
        }
      } else {
        await sendMessage(chatId, "⏳ Ваш запрос ещё рассматривается");
      }
      return;
    }
    // Проверка статуса
    if (!user || user.status !== "approved") {
      await sendMessage(chatId, "❌ Доступ запрещён");
      return;
    }
    // /status
    if (text === "/status") {
      if (!checkRateLimit(userId, "/status")) return;
      await sendMessage(chatId, formatStatusMessage(user));
      return;
    }
    // /goods
    if (text === "/goods") {
      if (!checkRateLimit(userId, "/goods")) return;
      const monitoringCodes = await getUserMonitoringProducts(userId);
      if (monitoringCodes.length === 0) {
        await sendMessage(chatId, "📭 У вас нет товаров в мониторинге");
        return;
      }
      const data = await getProductsFromServer();
      if (!data?.products) {
        await sendMessage(chatId, "❌ Не удалось получить список товаров");
        return;
      }
      const monitoringProducts = data.products.filter((p) =>
        monitoringCodes.includes(p.code),
      );
      if (!monitoringProducts.length) {
        await sendMessage(chatId, "📭 В вашем мониторинге нет товаров");
        return;
      }
      await sendMessage(
        chatId,
        `📦 В вашем мониторинге: ${monitoringProducts.length} товаров. Отправляю список...`,
      );
      const batchSize = 50;
      for (let i = 0; i < monitoringProducts.length; i += batchSize) {
        const batch = monitoringProducts.slice(i, i + batchSize);
        const list = batch.map((p) => `• ${p.name}`).join("\n");
        const header = `📋 Часть ${Math.floor(i / batchSize) + 1}/${Math.ceil(monitoringProducts.length / batchSize)}:\n\n`;
        await sendMessage(chatId, header + list);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return;
    }
    // /changes
    if (text === "/changes") {
      if (!checkRateLimit(userId, "/changes")) return;
      const monitoringCodes = await getUserMonitoringProducts(userId);
      if (monitoringCodes.length === 0) {
        await sendMessage(chatId, "📭 У вас нет товаров в мониторинге");
        return;
      }
      const allChanges = await getPriceChanges();
      const changes = allChanges.filter((c) =>
        monitoringCodes.includes(c.product_code),
      );
      if (!changes.length) {
        await sendMessage(chatId, "📭 Сегодня нет изменений по вашим товарам");
        return;
      }
      // Форматируем все изменения в одно сообщение
      const message = formatChangesList(
        changes,
        "📊 ИЗМЕНЕНИЯ ЦЕН В МОНИТОРИНГЕ",
      );
      await sendMessage(chatId, message);
      return;
    }
    // /help
    if (text === "/help") {
      await sendMessage(chatId, formatHelpMessage());
      return;
    }
    await sendMessage(chatId, "❓ Неизвестная команда. /help");
  } catch (err) {
    Logger.error("Ошибка обработки сообщения", err, {
      userId,
      command: text,
    });
    await sendMessage(chatId, "❌ Произошла внутренняя ошибка");
  }
}
