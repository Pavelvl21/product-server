import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateBot } from '../middleware/botAuth.js';
import { globalRateLimiter, authLimiter } from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';

import * as authController from '../controllers/authController.js';
import * as productController from '../controllers/productController.js';
import * as userController from '../controllers/userController.js';
import * as publicController from '../controllers/publicController.js';
import * as externalController from '../controllers/externalController.js';
import * as adminController from '../controllers/adminController.js';
import * as telegramController from '../controllers/telegramController.js';

const router = express.Router();

// ==================== ПУБЛИЧНЫЕ МАРШРУТЫ ====================
router.get('/api/public/categories', publicController.getCategories);
router.get('/api/public/brands', publicController.getBrands);
router.post('/api/public/user/categories', publicController.updateUserCategories);
router.post('/api/public/user/approve', publicController.approveUser);

// ==================== АУТЕНТИФИКАЦИЯ ====================
router.post('/api/register', authLimiter, validate(schemas.register), authController.register);
router.post('/api/login', authLimiter, authController.login);

// ==================== ТОВАРЫ (требуют аутентификации) ====================
router.get('/api/products', authenticateToken, productController.getProducts);
router.get('/api/products/paginated', authenticateToken, productController.getPaginatedProducts);
router.get('/api/products/catalog', authenticateToken, productController.getCatalogProducts);
router.get('/api/products/check/:code', authenticateToken, productController.checkProduct);
router.post('/api/products/add-full', authenticateToken, productController.addFullProduct);
router.get('/api/products/history', authenticateToken, productController.getProductsWithDateFilter);

router.get('/api/codes', authenticateToken, productController.getCodes);
router.post('/api/codes', authenticateToken, validate(schemas.addCode), productController.addCode);
router.post('/api/codes/bulk', authenticateToken, validate(schemas.bulkAddCodes), productController.bulkAddCodes);
router.delete('/api/codes/:code', authenticateToken, productController.deleteCode);

// ==================== ПОЛЬЗОВАТЕЛЬСКАЯ ПОЛКА ====================
router.get('/api/user/shelf', authenticateToken, userController.getShelf);
router.get('/api/user/shelf/paginated', authenticateToken, userController.getShelfPaginated);
router.post('/api/user/shelf/:code', authenticateToken, userController.addToShelf);
router.delete('/api/user/shelf/:code', authenticateToken, userController.removeFromShelf);
router.post('/api/user/shelf/status', authenticateToken, userController.checkShelfStatus);

router.get('/api/user/info', authenticateToken, userController.getUserInfo);
router.get('/api/user/stats', authenticateToken, userController.getUserStats);
router.post('/api/user/change-password', authenticateToken, validate(schemas.changePassword), userController.changePassword);

// ==================== ФИЛЬТРЫ ====================
router.get('/api/filter-stats', authenticateToken, userController.getFilterStats);
router.get('/api/filter-options', authenticateToken, userController.getFilterOptions);

// ==================== ВНЕШНИЙ ПОИСК ====================
router.get('/api/external/search', authenticateToken, externalController.searchExternal);

// ==================== АДМИНСКИЕ МАРШРУТЫ ====================
router.get('/api/allowed-emails', authenticateBot, adminController.getAllowedEmails);
router.post('/api/allowed-emails', authenticateBot, validate(schemas.email), adminController.addAllowedEmail);
router.get('/api/bot/products', authenticateBot, adminController.getBotProducts);
router.get('/api/stats', authenticateToken, adminController.getStats);

// ==================== TELEGRAM ====================
router.post('/api/telegram/webhook', telegramController.webhook);

// ==================== РАЗОВЫЙ ЭНДПОИНТ ДЛЯ TELEGRAM (из setupBotEndpoints) ====================
router.get('/api/telegram/users', authenticateToken, telegramController.getUsers);
//======ДОБАВЛЕНИЕ ТОВАРА В БД =========
router.post('/api/products/fetch-and-add', authenticateToken, productController.fetchAndAddProduct);

export default router;
