import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import { config } from './config/env.js';
import { globalRateLimiter, authLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';
import Logger from './services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Доверяем прокси
app.set('trust proxy', 1);

// Безопасность
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://price-hunter-bel.vercel.app',
    /^https:\/\/.*\.app\.github\.dev$/,
    /^http:\/\/localhost:\d+$/
  ];
  
  const isAllowed = allowedOrigins.some(pattern => {
    if (pattern instanceof RegExp) {
      return pattern.test(origin);
    }
    return pattern === origin;
  });
  
  if (origin && isAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key, x-bot-key, cache-control, pragma, expires, if-none-match, if-modified-since');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limiting
app.use('/api/', globalRateLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// Парсеры
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Маршруты
app.use(routes);

// Статическая страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Обработка ошибок (последний middleware)
app.use(errorHandler);

export default app;