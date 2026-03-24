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

export async function sendEmail(to, subject, html) {
  try {
    const transporter = getTransporter();
    
    const info = await transporter.sendMail({
      from: config.EMAIL_FROM,
      to: to,
      subject: subject,
      html: html
    });
    
    Logger.info('Письмо отправлено', { to, messageId: info.messageId });
    return true;
  } catch (err) {
    Logger.error('Ошибка отправки письма', err, { to });
    return false;
  }
}

export async function sendRegistrationEmail(email, tempPassword, expiresAt) {
  const expiresDate = new Date(expiresAt);
  const expiresFormatted = expiresDate.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Minsk'
  });
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          text-align: center;
          border-radius: 10px 10px 0 0;
        }
        .content {
          background: #f9f9f9;
          padding: 30px;
          border-radius: 0 0 10px 10px;
          border: 1px solid #e0e0e0;
          border-top: none;
        }
        .password-box {
          background: #fff;
          border: 2px solid #667eea;
          border-radius: 8px;
          padding: 15px;
          text-align: center;
          margin: 20px 0;
        }
        .password {
          font-size: 24px;
          font-weight: bold;
          font-family: monospace;
          color: #667eea;
          letter-spacing: 2px;
        }
        .button {
          display: inline-block;
          background: #667eea;
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 5px;
          margin: 20px 0;
        }
        .warning {
          background: #fff3cd;
          border-left: 4px solid #ffc107;
          padding: 12px;
          margin: 20px 0;
        }
        .footer {
          text-align: center;
          color: #999;
          font-size: 12px;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #e0e0e0;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Добро пожаловать в Price Hunter! 🎯</h1>
      </div>
      <div class="content">
        <p>Здравствуйте!</p>
        <p>Ваша регистрация в сервисе мониторинга цен <strong>Price Hunter</strong> успешно подтверждена.</p>
        
        <div class="password-box">
          <p><strong>Ваш временный пароль:</strong></p>
          <div class="password">${tempPassword}</div>
        </div>
        
        <div class="warning">
          ⚠️ <strong>ВНИМАНИЕ!</strong><br>
          • Этот пароль является <strong>временным</strong>.<br>
          • Срок действия пароля: <strong>${expiresFormatted}</strong> (72 часа).<br>
          • <strong>Обязательно смените пароль</strong> после первого входа!
        </div>
        
        <p style="text-align: center;">
          <a href="https://price-hunter-bel.vercel.app/login" class="button">
            🔐 Войти в личный кабинет
          </a>
        </p>
        
        <p>После входа вы сможете:</p>
        <ul>
          <li>📊 Отслеживать изменения цен на товары</li>
          <li>❤️ Добавлять товары в избранное</li>
          <li>📈 Смотреть историю изменения цен</li>
          <li>🔔 Получать уведомления об изменениях</li>
        </ul>
        
        <p>Если вы не регистрировались в Price Hunter, просто проигнорируйте это письмо.</p>
        
        <div class="footer">
          <p>Это автоматическое сообщение, пожалуйста, не отвечайте на него.</p>
          <p>© 2026 Price Hunter. Все права защищены.</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  return await sendEmail(email, 'Добро пожаловать в Price Hunter! Ваш временный пароль', html);
}