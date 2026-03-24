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
      
      // Очищаем временный пароль
      await db.execute({
        sql: 'UPDATE users SET temp_password = NULL, temp_password_expires = NULL WHERE username = ?',
        args: [sanitizedUsername]
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
      sql: `SELECT id, username, password_hash, temp_password, temp_password_expires 
            FROM users WHERE username = ?`,
      args: [username]
    });
    
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    let isValid = await bcrypt.compare(password, user.password_hash);
    let isTempPassword = false;
    
    if (!isValid && user.temp_password) {
      isValid = password === user.temp_password;
      if (isValid) {
        const expiresAt = new Date(user.temp_password_expires);
        const now = new Date();
        
        if (now > expiresAt) {
          return res.status(401).json({ 
            error: 'Временный пароль истек. Запросите новый пароль у администратора.' 
          });
        }
        isTempPassword = true;
      }
    }
    
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ 
      token,
      isTempPassword,
      message: isTempPassword ? 'Используется временный пароль. Рекомендуем сменить его.' : null
    });
    
  } catch (err) {
    Logger.error('Ошибка входа', err, { username: req.body?.username });
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.validatedBody;
    
    // ========== ЛОГ 1 ==========
    console.log('🔍 [changePassword] Начало');
    console.log('   userId:', userId);
    console.log('   currentPassword length:', currentPassword?.length);
    console.log('   newPassword length:', newPassword?.length);
    
    const user = await db.execute({
      sql: `SELECT username, password_hash, temp_password, temp_password_expires 
            FROM users WHERE id = ?`,
      args: [userId]
    });
    
    if (user.rows.length === 0) {
      console.log('❌ [changePassword] Пользователь не найден, userId:', userId);
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // ========== ЛОГ 2 ==========
    console.log('🔍 [changePassword] Найден пользователь:', {
      username: user.rows[0].username,
      hasHash: !!user.rows[0].password_hash,
      hasTempPassword: !!user.rows[0].temp_password,
      tempExpires: user.rows[0].temp_password_expires
    });
    
    // Проверка, что новый пароль не содержит email
    const username = user.rows[0].username;
    const emailLocalPart = username.split('@')[0].toLowerCase();
    const newPasswordLower = newPassword.toLowerCase();
    
    if (newPasswordLower.includes(emailLocalPart) || newPasswordLower.includes(username.toLowerCase())) {
      console.log('❌ [changePassword] Пароль содержит email');
      return res.status(400).json({ 
        error: 'Пароль не должен содержать email или имя пользователя' 
      });
    }
    
    // Проверяем текущий пароль (обычный или временный)
    let isValid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    let isTempPassword = false;
    
    console.log('🔍 [changePassword] Проверка пароля:');
    console.log('   bcrypt compare result:', isValid);
    console.log('   has temp_password:', !!user.rows[0].temp_password);
    
    if (!isValid && user.rows[0].temp_password) {
      console.log('🔍 [changePassword] Проверяем временный пароль...');
      isValid = currentPassword === user.rows[0].temp_password;
      console.log('   temp password match:', isValid);
      
      if (isValid) {
        const expiresAt = new Date(user.rows[0].temp_password_expires);
        const now = new Date();
        
        console.log('   expiresAt:', expiresAt);
        console.log('   now:', now);
        console.log('   isExpired:', now > expiresAt);
        
        if (now > expiresAt) {
          console.log('❌ [changePassword] Временный пароль истек');
          return res.status(401).json({ error: 'Временный пароль истек' });
        }
        isTempPassword = true;
      }
    }
    
    if (!isValid) {
      console.log('❌ [changePassword] Неверный текущий пароль');
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    
    const isSameAsOld = await bcrypt.compare(newPassword, user.rows[0].password_hash);
    if (isSameAsOld) {
      console.log('❌ [changePassword] Новый пароль совпадает со старым');
      return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
    }
    
    // ========== ЛОГ 3 ==========
    console.log('🔍 [changePassword] Обновляем пароль, очищаем временный...');
    
    const hash = await bcrypt.hash(newPassword, 10);
    
    const updateResult = await db.execute({
      sql: `UPDATE users 
            SET password_hash = ?, 
                temp_password = NULL, 
                temp_password_expires = NULL 
            WHERE id = ?`,
      args: [hash, userId]
    });
    
    // ========== ЛОГ 4 ==========
    console.log('🔍 [changePassword] Результат UPDATE:', {
      changes: updateResult.changes,
      lastInsertRowid: updateResult.lastInsertRowid
    });
    
    // Проверяем, что очистилось
    const checkUser = await db.execute({
      sql: 'SELECT temp_password, temp_password_expires FROM users WHERE id = ?',
      args: [userId]
    });
    
    console.log('🔍 [changePassword] После UPDATE:', {
      tempPassword: checkUser.rows[0]?.temp_password,
      tempExpires: checkUser.rows[0]?.temp_password_expires
    });
    
    Logger.info('Пароль изменен', { userId, wasTempPassword: isTempPassword });
    res.json({ message: 'Пароль успешно изменен' });
    
  } catch (err) {
    console.error('❌ [changePassword] Ошибка:', err);
    Logger.error('Ошибка смены пароля', err, { userId: req.user?.id });
    next(err);
  }
}