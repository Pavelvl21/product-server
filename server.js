// server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Настройка middleware ---
app.use(express.json());

// --- Подключение к базе данных и её инициализация ---
const dbPath = path.join(__dirname, 'products.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        db.run(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id TEXT NOT NULL,
                name TEXT NOT NULL,
                price REAL NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error('Ошибка создания таблицы:', err.message);
            } else {
                console.log('Таблица "products" готова.');
            }
        });
    }
});

// --- ПОЛУЧЕНИЕ ВСЕХ ТОВАРОВ (доступно всем) ---
app.get('/products', (req, res) => {
    const sql = `SELECT * FROM products ORDER BY created_at DESC`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Ошибка при чтении данных:', err.message);
            return res.status(500).json({ error: 'Не удалось получить список товаров.' });
        }
        res.json(rows);
    });
});

// --- СОХРАНЕНИЕ НОВОГО ТОВАРА (только с ключом) ---
app.post('/products', (req, res) => {
    // Получаем секретный ключ из переменной окружения
    const MY_SECRET_KEY = process.env.SECRET_KEY;
    
    // Если ключ не задан в окружении - это ошибка конфигурации
    if (!MY_SECRET_KEY) {
        console.error('ОШИБКА: SECRET_KEY не задан в переменных окружения!');
        return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
    }
    
    // Получаем ключ из заголовка запроса
    const userKey = req.headers['x-secret-key'];
    
    // Проверяем, совпадает ли ключ с вашим секретным ключом
    if (!userKey || userKey !== MY_SECRET_KEY) {
        return res.status(403).json({ error: 'Доступ запрещен. Неверный секретный ключ.' });
    }

    // Получаем данные из тела запроса
    const { product_id, name, price } = req.body;

    // Простейшая валидация: проверяем, что все поля на месте
    if (!product_id || !name || price === undefined) {
        return res.status(400).json({ error: 'Пожалуйста, укажите product_id, name и price.' });
    }

    // Вставка данных в базу
    const sql = `INSERT INTO products (product_id, name, price) VALUES (?, ?, ?)`;
    db.run(sql, [product_id, name, price], function(err) {
        if (err) {
            console.error('Ошибка при вставке данных:', err.message);
            return res.status(500).json({ error: 'Не удалось сохранить товар.' });
        }
        // Отправляем успешный ответ с ID созданной записи
        res.status(201).json({
            message: 'Товар успешно сохранён!',
            id: this.lastID
        });
    });
});

// --- НОВЫЙ МАРШРУТ: ОЧИСТКА ВСЕХ ДАННЫХ (только с ключом) ---
app.delete('/products', (req, res) => {
    // Получаем секретный ключ из переменной окружения
    const MY_SECRET_KEY = process.env.SECRET_KEY;
    
    // Проверяем наличие ключа в окружении
    if (!MY_SECRET_KEY) {
        console.error('ОШИБКА: SECRET_KEY не задан в переменных окружения!');
        return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
    }
    
    // Получаем ключ из заголовка запроса
    const userKey = req.headers['x-secret-key'];
    
    // Проверяем ключ
    if (!userKey || userKey !== MY_SECRET_KEY) {
        return res.status(403).json({ error: 'Доступ запрещен. Неверный секретный ключ.' });
    }

    // Удаляем все записи из таблицы
    const sql = `DELETE FROM products`;
    
    db.run(sql, function(err) {
        if (err) {
            console.error('Ошибка при очистке данных:', err.message);
            return res.status(500).json({ error: 'Не удалось очистить данные.' });
        }
        
        // Отправляем успешный ответ с количеством удалённых записей
        res.json({ 
            message: 'Все данные успешно удалены!',
            deletedCount: this.changes // количество удалённых записей
        });
    });
});

// --- Корневой маршрут для простой проверки работы сервера ---
app.get('/', (req, res) => {
    res.send('Сервер работает! Используйте /products для работы с данными.');
});

// --- Запуск сервера ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
