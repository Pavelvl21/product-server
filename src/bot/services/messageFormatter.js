export function formatPrice(price, options = {}) {
  if (price === null || price === undefined) return '—';
  
  const num = typeof price === 'string' ? parseFloat(price) : Number(price);
  if (isNaN(num)) return '—';
  
  const formatted = num.toFixed(2).replace('.', ',');
  
  const { withSign = false } = options;
  
  if (!withSign) return formatted;
  
  if (num > 0) return `+${formatted}`;
  if (num < 0) return `-${formatted}`;
  return formatted;
}

export function formatProductFull(product) {
  const emoji = product.isDecrease ? '🔴' : '🟢';
  
  const retailPrice = product.base_price || product.packPrice || null;
  
  return `${emoji} ${product.product_name}
📋 Код: ${product.product_code}
💰 Было: ${formatPrice(product.previous_price)} руб.
💰 Стало: ${formatPrice(product.current_price)} руб. ${emoji} ${formatPrice(product.change, { withSign: true })} (${product.percent}%)
💳 РЦ в рассрочку: ${formatPrice(retailPrice)} руб.
⏱ Срок: ${product.no_overpayment_max_months || '—'} мес.
🔗 <a href="https://www.21vek.by${product.link}">Ссылка</a>`;
}

export function formatPriceChangeNotification(product, oldPrice, newPrice) {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const isDecrease = change < 0;
  
  return formatProductFull({
    product_code: product.code,
    product_name: product.name,
    current_price: newPrice,
    previous_price: oldPrice,
    change: change,
    percent: percent,
    base_price: product.basePrice || product.price,
    packPrice: product.packPrice,
    monthly_payment: product.monthly_payment,
    no_overpayment_max_months: product.no_overpayment_max_months,
    link: product.link,
    category: product.category,
    isDecrease: isDecrease
  });
}

/**
 * Форматирует список изменений в одно сообщение
 * @param {Array} changes - массив изменений
 * @param {string} title - заголовок сообщения
 * @returns {string} отформатированное сообщение
 */
export function formatChangesList(changes, title = '📊 ИЗМЕНЕНИЯ ЦЕН') {
  if (!changes || changes.length === 0) {
    return '📭 Нет изменений цен за сегодня';
  }
  
  // Сортировка: сначала повышения (от большего к меньшему), затем снижения (от большего к меньшему)
  const sortedChanges = [...changes].sort((a, b) => {
    // Сначала по типу (повышения выше)
    if (a.isDecrease !== b.isDecrease) {
      return a.isDecrease ? 1 : -1;
    }
    // Затем по абсолютному значению изменения (от большего к меньшему)
    return Math.abs(b.change) - Math.abs(a.change);
  });
  
  const changesText = sortedChanges.map(change => formatProductFull(change)).join('\n\n────────────────────\n\n');
  
  const increaseCount = sortedChanges.filter(c => !c.isDecrease).length;
  const decreaseCount = sortedChanges.filter(c => c.isDecrease).length;
  
  const footer = `\n\n────────────────────\n📊 Всего изменений: ${changes.length}\n🔺 Повышение: ${increaseCount}\n🔻 Снижение: ${decreaseCount}`;
  
  return `${title}\n\n${changesText}${footer}`;
}

export function formatHelpMessage() {
  return `
📋 <b>Доступные команды:</b>

👤 <b>Для всех:</b>
/help - это сообщение
/start - начало работы
/status - статус и категории
/changes - изменения цен за сегодня (только по вашему мониторингу)
/goods - список товаров по категориям

ℹ️ Категории выбираются один раз при регистрации.
`;
}

export function formatStatusMessage(user) {
  const locked = user.selection_locked ? 'заблокирован' : 'можно выбрать';
  const categories = user.selected_categories || [];
  const catText = categories.length 
    ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
    : '\n📁 Категории не выбраны';
  
  return `✅ Статус: подтверждён\n🔒 Выбор категорий: ${locked}${catText}`;
}