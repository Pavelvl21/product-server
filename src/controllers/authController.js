import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../../database.js';
import { config } from '../config/env.js';
import { schemas, sanitizeInput } from '../middleware/validation.js';
import Logger from '../services/logger.js';

export async function register(req, res, next) {
  try {
    const { username, password } = req.validatedBody;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    
    const sanitizedUsername = sanitizeInput(username);
    
    // Проверка белого списка
    const allowed = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [sanitizedUsername]
    });
    
    if (allowed.rows.length === 0) {
      Logger.warn('Попытка регистрации с неразрешенным email', { email: sanitizedUsername });
      return res.status(403).json({ error: 'Email не в белом списке' });
    }
    
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
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      Logger.warn('Неудачная попытка входа', { email: username });
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    Logger.info('Пользователь вошел', { userId: user.id });
    res.json({ token });
    
  } catch (err) {
    Logger.error('Ошибка входа', err, { username: req.body?.username });
    next(err);
  }
}