// categoryRelations.js
import db from './database.js';

export async function updateCategoryBrandRelations(category, brand) {
  if (!category || !brand || category === 'Товары' || brand === 'Без бренда') {
    return;
  }

  try {
    // Проверяем, существует ли уже такая связь
    const existing = await db.execute({
      sql: 'SELECT id, products_count FROM category_brand_relations WHERE category = ? AND brand = ?',
      args: [category, brand]
    });

    if (existing.rows.length > 0) {
      // Обновляем счётчик
      await db.execute({
        sql: `
          UPDATE category_brand_relations 
          SET products_count = products_count + 1, last_updated = CURRENT_TIMESTAMP
          WHERE category = ? AND brand = ?
        `,
        args: [category, brand]
      });
    } else {
      // Создаём новую связь
      await db.execute({
        sql: `
          INSERT INTO category_brand_relations (category, brand, products_count)
          VALUES (?, ?, 1)
        `,
        args: [category, brand]
      });
    }
  } catch (err) {
    console.error('❌ Ошибка обновления связей:', err);
  }
}
