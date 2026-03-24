import nodemailer from 'nodemailer';
import { config } from '../config/env.js';
import Logger from './logger.js';

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: config.EMAIL_USER,
        pass: config.EMAIL_PASS
      }
    });
  }
  return transporter;
}

export async function sendEmail(to, subject, text) {
  try {
    const transporter = getTransporter();
    
    const info = await transporter.sendMail({
      from: config.EMAIL_FROM,
      to: to,
      subject: subject,
      text: text
    });
    
    Logger.info('Письмо отправлено', { to, messageId: info.messageId });
    return true;
  } catch (err) {
    Logger.error('Ошибка отправки письма', err, { to });
    return false;
  }
}

export async function sendRegistrationLink(email) {
  const text = `
Добро пожаловать в Price Hunter!

Ваша регистрация подтверждена.

Для завершения регистрации и создания пароля перейдите по ссылке:
https://price-hunter-bel.vercel.app/register?email=${encodeURIComponent(email)}

После регистрации вы сможете войти в личный кабинет и пользоваться ботом.

📋 Команды бота:
/changes - изменения цен
/status - статус
/help - помощь

---
Price Hunter
  `;
  
  return await sendEmail(email, 'Завершение регистрации в Price Hunter', text);
}