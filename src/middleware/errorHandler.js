import Logger from '../services/logger.js';

export class AppError extends Error {
  constructor(message, statusCode, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}

export function errorHandler(err, req, res, next) {
  // Логируем ошибку с контекстом
  Logger.error(
    err.message || 'Неизвестная ошибка',
    err,
    {
      method: req.method,
      url: req.url,
      userId: req.user?.id,
      ip: req.ip,
      body: req.method === 'POST' ? { ...req.body, password: undefined } : undefined
    }
  );
  
  // Операционные ошибки (ожидаемые)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.details && { details: err.details })
    });
  }
  
  // Ошибки Joi валидации
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Некорректные данные',
      details: err.details.map(d => d.message)
    });
  }
  
  // Ошибки базы данных
  if (err.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json({ error: 'Конфликт данных' });
  }
  
  // Непредвиденные ошибки
  res.status(500).json({ 
    error: 'Внутренняя ошибка сервера',
    requestId: req.id // если добавить генерацию ID
  });
}