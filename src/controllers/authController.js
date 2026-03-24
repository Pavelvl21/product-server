import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../../database.js';
import { config } from '../config/env.js';
import { sanitizeInput } from '../middleware/validation.js';
import Logger from '../services/logger.js';

export async function register(req, res, next) {
  try {
    const { username, password } = req.validatedBody;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    
    const sanitizedUsername = sanitizeInput(username);
    
    const allowed = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [sanitizedUsername]
    });
    
    if (allowed.rows.length === 0) {
      Logger.warn('Попытка регистрации с неразрешенным email', { email: sanitizedUsername });
      return res.status(403).json({ error: 'Email не в белом списке' });
    }
    
    // Проверка, что пароль не содержит email
    const emailLocalPart = sanitizedUsername.split('@')[0].toLowerCase();
    const passwordLower = password.toLowerCase();
    
    if (passwordLower.includes(emailLocalPart) || passwordLower.includes(sanitizedUsername.toLowerCase())) {
      return res.status(400).json({ 
        error: 'Пароль не должен содержать email или имя пользователя' 
      });
    }
    
    // Проверяем, существует ли пользователь
    const existingUser = await db.execute({
      sql: 'SELECT id FROM users WHERE username = ?',
      args: [sanitizedUsername]
    });
    
    if (existingUser.rows.length > 0) {
      // Пользователь уже есть (создан через бота), обновляем пароль
      const hash = await bcrypt.hash(password, 10);
      await db.execute({
        sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
        args: [hash, sanitizedUsername]
      });
      
      return res.status(200).json({ message: 'Пароль успешно установлен. Теперь вы можете войти.' });
    }
    
    // Новый пользователь
    const hash = await bcrypt.hash(password, 10);
    
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [sanitizedUsername, hash]
    });
    
    Logger.info('Пользователь зарегистрирован', { email: sanitizedUsername });
    res.status(201).json({ message: 'Регистрация успешна' });
    
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }
    Logger.error('Ошибка регистрации', err, { username: req.body?.username });
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    
    const result = await db.execute({
      sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
      args: [username]
    });
    
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    // Проверяем, что пароль не пустой
    if (!user.password_hash || user.password_hash === '') {
      return res.status(401).json({ error: 'Пароль не установлен. Завершите регистрацию по ссылке из письма.' });
    }
    
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ token });
    
  } catch (err) {
    Logger.error('Ошибка входа', err, { username: req.body?.username });
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.validatedBody;
    
    const user = await db.execute({
      sql: `SELECT username, password_hash FROM users WHERE id = ?`,
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверка, что новый пароль не содержит email
    const username = user.rows[0].username;
    const emailLocalPart = username.split('@')[0].toLowerCase();
    const newPasswordLower = newPassword.toLowerCase();
    
    if (newPasswordLower.includes(emailLocalPart) || newPasswordLower.includes(username.toLowerCase())) {
      return res.status(400).json({ 
        error: 'Пароль не должен содержать email или имя пользователя' 
      });
    }
    
    const isValid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    
    const isSameAsOld = await bcrypt.compare(newPassword, user.rows[0].password_hash);
    if (isSameAsOld) {
      return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
    }
    
    const hash = await bcrypt.hash(newPassword, 10);
    
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [hash, userId]
    });
    
    Logger.info('Пароль изменен', { userId });
    res.json({ message: 'Пароль успешно изменен' });
    
  } catch (err) {
    Logger.error('Ошибка смены пароля', err, { userId: req.user?.id });
    next(err);
  }
}