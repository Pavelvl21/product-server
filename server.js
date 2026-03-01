// server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Настройка middleware ---
app.use(express.json());
app.use(express.static('public')); // Для HTML-страницы

// --- Подключение к базе данных ---
const dbPath = path.join(__dirname, 'products.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        
        // Таблица для хранения кодов товаров
        db.run(`
            CREATE TABLE IF NOT EXISTS product_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Таблица для хранения истории цен
        db.run(`
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_code TEXT NOT NULL,
                product_name TEXT NOT NULL,
                price REAL NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_code) REFERENCES product_codes (code)
            )
        `);

        // Таблица для хранения последних данных о товарах
        db.run(`
            CREATE TABLE IF NOT EXISTS products_info (
                code TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                last_price REAL NOT NULL,
                last_update DATETIME DEFAULT CURRENT_TIMESTAMP,
                link TEXT,
                category TEXT,
                brand TEXT
            )
        `);
        
        console.log('Все таблицы созданы или уже существуют');
    }
});

// --- ПОЛУЧЕНИЕ СЕКРЕТНОГО КЛЮЧА ---
const MY_SECRET_KEY = process.env.SECRET_KEY;
if (!MY_SECRET_KEY) {
    console.error('ВНИМАНИЕ: SECRET_KEY не задан в переменных окружения!');
}

// --- ВАЛИДАЦИЯ КОДА ТОВАРА (только цифры, до 12 символов) ---
function validateProductCode(code) {
    return /^\d{1,12}$/.test(code);
}

// --- API: ПОЛУЧИТЬ ВСЕ КОДЫ (для расширения) ---
app.get('/api/codes', (req, res) => {
    db.all('SELECT code FROM product_codes ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => row.code));
    });
});

// --- API: ДОБАВИТЬ КОД (только с ключом) ---
app.post('/api/codes', (req, res) => {
    // Проверка ключа
    const userKey = req.headers['x-secret-key'];
    if (!userKey || userKey !== MY_SECRET_KEY) {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const { code } = req.body;

    // Валидация: только цифры, до 12 символов
    if (!validateProductCode(code)) {
        return res.status(400).json({ 
            error: 'Код должен содержать только цифры (до 12 символов)' 
        });
    }

    db.run('INSERT OR IGNORE INTO product_codes (code) VALUES (?)', [code], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            return res.json({ message: 'Код уже существует', code });
        }
        
        console.log(`✅ Новый код добавлен: ${code}, запускаем немедленное обновление`);
        
        // Запускаем немедленное обновление для нового кода
        updatePricesForNewCode(code);
        
        res.status(201).json({ message: 'Код добавлен', code });
    });
});

// --- API: УДАЛИТЬ КОД (только с ключом) ---
app.delete('/api/codes/:code', (req, res) => {
    const userKey = req.headers['x-secret-key'];
    if (!userKey || userKey !== MY_SECRET_KEY) {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const code = req.params.code;

    db.serialize(() => {
        db.run('DELETE FROM price_history WHERE product_code = ?', [code]);
        db.run('DELETE FROM products_info WHERE code = ?', [code]);
        db.run('DELETE FROM product_codes WHERE code = ?', [code], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Код не найден' });
            }
            
            res.json({ message: 'Код удалён', code });
        });
    });
});

// --- API: ПОЛУЧИТЬ ДАННЫЕ ДЛЯ ТАБЛИЦЫ (веб-интерфейс) ---
app.get('/api/products', (req, res) => {
    // Получаем все уникальные даты обновлений
    db.all(`
        SELECT DISTINCT DATE(updated_at) as update_date 
        FROM price_history 
        ORDER BY update_date DESC
    `, [], (err, dates) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const dateColumns = dates.map(d => d.update_date);

        // Получаем все товары с их ценами по датам
        db.all(`
            SELECT 
                p.code,
                p.name,
                p.link,
                p.category,
                p.brand,
                ph.price,
                DATE(ph.updated_at) as update_date
            FROM products_info p
            LEFT JOIN price_history ph ON p.code = ph.product_code
            ORDER BY p.name
        `, [], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            // Группируем по товарам
            const products = {};
            rows.forEach(row => {
                if (!products[row.code]) {
                    products[row.code] = {
                        code: row.code,
                        name: row.name,
                        link: row.link,
                        category: row.category,
                        brand: row.brand,
                        prices: {}
                    };
                }
                if (row.update_date) {
                    products[row.code].prices[row.update_date] = row.price;
                }
            });

            res.json({
                dates: dateColumns,
                products: Object.values(products)
            });
        });
    });
});

// --- ФУНКЦИЯ: Обновление цен через API 21vek.by для всех кодов ---
async function updateAllPrices() {
    console.log('🔄 Начинаем обновление цен:', new Date().toLocaleString());

    // Получаем все коды товаров
    db.all('SELECT code FROM product_codes', [], async (err, codes) => {
        if (err) {
            console.error('Ошибка при получении кодов:', err);
            return;
        }
        
        if (codes.length === 0) {
            console.log('📭 Нет кодов для обновления');
            return;
        }

        const productCodes = codes.map(c => c.code);
        console.log(`📦 Найдено кодов: ${productCodes.length}`);

        try {
            const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
                "headers": {
                    "accept": "application/json",
                    "content-type": "application/json"
                },
                "body": JSON.stringify({
                    ids: productCodes.map(code => parseInt(code)),
                    isAdult: false,
                    limit: 100
                }),
                "method": "POST"
            });

            if (!response.ok) {
                console.error('❌ Ошибка HTTP:', response.status);
                return;
            }

            const data = await response.json();
            const products = data.data.productCards;

            if (!products || products.length === 0) {
                console.log('📭 Нет данных от API');
                return;
            }

            console.log(`📥 Получены данные для ${products.length} товаров`);

            // Обновляем данные в БД
            db.serialize(() => {
                products.forEach(product => {
                    const code = product.code.toString();
                    const price = parseFloat(product.packPrice || product.price);
                    
                    // Получаем категорию и бренд
                    let category = 'Товары';
                    if (product.categories && product.categories.length > 0) {
                        category = product.categories[product.categories.length - 1].name;
                    }
                    const brand = product.producerName || 'Без бренда';

                    // Сохраняем в историю цен
                    db.run(
                        `INSERT INTO price_history (product_code, product_name, price) VALUES (?, ?, ?)`,
                        [code, product.name, price]
                    );

                    // Обновляем или вставляем в products_info
                    db.run(
                        `INSERT OR REPLACE INTO products_info (code, name, last_price, link, category, brand, last_update) 
                         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [code, product.name, price, product.link || '', category, brand]
                    );
                });
            });

            console.log('✅ Обновление завершено');

        } catch (error) {
            console.error('❌ Ошибка при обновлении цен:', error);
        }
    });
}

// --- ФУНКЦИЯ: Обновление цен для одного нового кода ---
async function updatePricesForNewCode(code) {
    console.log(`🔄 Начинаем обновление для нового кода: ${code}`);
    
    try {
        const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
            "headers": { "content-type": "application/json" },
            "body": JSON.stringify({ 
                ids: [parseInt(code)], 
                isAdult: false, 
                limit: 1 
            }),
            "method": "POST"
        });

        if (!response.ok) {
            console.error(`❌ Ошибка HTTP для кода ${code}:`, response.status);
            return;
        }

        const data = await response.json();
        const product = data.data.productCards[0];
        
        if (!product) {
            console.log(`📭 Нет данных для кода ${code} от API`);
            return;
        }

        const price = parseFloat(product.packPrice || product.price);
        
        let category = 'Товары';
        if (product.categories && product.categories.length > 0) {
            category = product.categories[product.categories.length - 1].name;
        }
        const brand = product.producerName || 'Без бренда';

        // Сохраняем в историю цен
        db.run(
            `INSERT INTO price_history (product_code, product_name, price) VALUES (?, ?, ?)`,
            [code, product.name, price]
        );

        // Обновляем или вставляем в products_info
        db.run(
            `INSERT OR REPLACE INTO products_info (code, name, last_price, link, category, brand, last_update) 
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [code, product.name, price, product.link || '', category, brand]
        );

        console.log(`✅ Данные для нового кода ${code} загружены: ${product.name} - ${price} руб.`);

    } catch (error) {
        console.error(`❌ Ошибка при загрузке данных для кода ${code}:`, error);
    }
}

// --- ПЛАНИРОВЩИК: запуск каждый час ---
cron.schedule('0 * * * *', () => {
    console.log('⏰ Запуск планового обновления цен');
    updateAllPrices();
});

// --- ВЕБ-ИНТЕРФЕЙС ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Запуск сервера ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📊 Веб-интерфейс: http://localhost:${PORT}`);
    
    // Первое обновление через 10 секунд после старта (если есть коды)
    setTimeout(() => {
        console.log('⏰ Запуск первого обновления после старта');
        updateAllPrices();
    }, 10000);
});
