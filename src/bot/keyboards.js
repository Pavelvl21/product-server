export function getCategoryKeyboard(userId, category) {
  return {
    inline_keyboard: [[
      { text: '➕ Добавить', callback_data: `add_cat_${userId}_${category}` }
    ]]
  };
}

export function getFinishKeyboard(userId) {
  return {
    inline_keyboard: [[
      { text: '✅ Завершить выбор', callback_data: `finish_selection_${userId}` }
    ]]
  };
}

export function getAdminUserKeyboard(userId) {
  return {
    inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `approve_${userId}` },
      { text: '❌ Отклонить', callback_data: `reject_${userId}` },
      { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
    ]]
  };
}

export function getSuccessKeyboard() {
  return {
    inline_keyboard: [[
      { text: '✅ Добавлено', callback_data: 'noop' }
    ]]
  };
}