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

export async function sendTempPasswordEmail(email, tempPassword, expiresAt) {
  const expiresDate = new Date(expiresAt);
  const expiresFormatted = expiresDate.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Minsk'
  });
  
  const text = `
Добро пожаловать в Price Hunter!

Ваша регистрация подтверждена.

Ваш временный пароль: ${tempPassword}

Срок действия пароля: до ${expiresFormatted} (72 часа)

После входа обязательно смените пароль.

---
Price Hunter
  `;
  
  return await sendEmail(email, 'Ваш временный пароль для Price Hunter', text);
}