import React, { useState, useMemo } from 'react';
import { Table, Badge, Form, Button } from 'react-bootstrap';
import { FaSort, FaSortUp, FaSortDown, FaExternalLinkAlt, FaEye } from 'react-icons/fa';

const PriceTable = ({ products, dates }) => {
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
  const [filterCategory, setFilterCategory] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterText, setFilterText] = useState('');
  const [highlightChanges, setHighlightChanges] = useState(true);

  const categories = [...new Set(products.map(p => p.category || 'Без категории'))];
  const brands = [...new Set(products.map(p => p.brand || 'Без бренда'))];

  const sortedProducts = useMemo(() => {
    let sortableProducts = [...products];
    
    if (sortConfig.key) {
      sortableProducts.sort((a, b) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];
        
        if (sortConfig.key === 'price') {
          aValue = a.prices[dates[0]] || 0;
          bValue = b.prices[dates[0]] || 0;
        }
        
        if (sortConfig.key === 'change') {
          const aLatest = a.prices[dates[0]] || 0;
          const aPrevious = a.prices[dates[1]] || aLatest;
          aValue = aLatest - aPrevious;
          
          const bLatest = b.prices[dates[0]] || 0;
          const bPrevious = b.prices[dates[1]] || bLatest;
          bValue = bLatest - bPrevious;
        }
        
        if (sortConfig.key === 'lastChangeDate') {
          aValue = a.lastPriceUpdate || 0;
          bValue = b.lastPriceUpdate || 0;
        }
        
        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    
    return sortableProducts;
  }, [products, sortConfig, dates]);

  const filteredProducts = sortedProducts.filter(product => {
    const matchesCategory = !filterCategory || product.category === filterCategory;
    const matchesBrand = !filterBrand || product.brand === filterBrand;
    const matchesText = !filterText || 
      product.name?.toLowerCase().includes(filterText.toLowerCase()) ||
      product.code.includes(filterText);
    
    return matchesCategory && matchesBrand && matchesText;
  });

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getSortIcon = (key) => {
    if (sortConfig.key !== key) return <FaSort className="ms-2" />;
    return sortConfig.direction === 'asc' ? 
      <FaSortUp className="ms-2" /> : 
      <FaSortDown className="ms-2" />;
  };

  const formatPriceChange = (currentPrice, previousPrice) => {
    if (!currentPrice) return { text: '—', class: 'neutral' };
    if (!previousPrice) return { text: 'новый', class: 'neutral' };
    
    const change = currentPrice - previousPrice;
    const percent = ((change / previousPrice) * 100).toFixed(1);
    
    if (Math.abs(change) < 0.01) {
      return { text: '0%', class: 'neutral' };
    }
    
    return {
      text: `${change > 0 ? '+' : ''}${change.toFixed(2)} ₽ (${percent}%)`,
      class: change > 0 ? 'positive' : 'negative'
    };
  };

  const hasPriceChanged = (product) => {
    for (let i = 0; i < dates.length - 1; i++) {
      const current = product.prices[dates[i]];
      const next = product.prices[dates[i + 1]];
      if (current && next && Math.abs(current - next) > 0.01) {
        return true;
      }
    }
    return false;
  };

  if (products.length === 0) {
    return (
      <div className="text-center py-5">
        <FaEye size={48} className="text-muted mb-3" />
        <h4 className="text-muted">База Price Hunter пуста</h4>
        <p className="text-muted">
          Добавьте коды товаров через форму выше и дождитесь первого обновления
        </p>
      </div>
    );
  }

  return (
    <div className="price-table-container">
      <div className="filter-section">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h5 className="mb-0">🔍 Фильтры и сортировка</h5>
          <Form.Check
            type="switch"
            id="highlight-changes"
            label="Подсвечивать изменения"
            checked={highlightChanges}
            onChange={(e) => setHighlightChanges(e.target.checked)}
          />
        </div>

        <div className="row g-3">
          <div className="col-md-4">
            <Form.Group>
              <Form.Label>Поиск</Form.Label>
              <Form.Control
                type="text"
                placeholder="Название или код..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
            </Form.Group>
          </div>
          <div className="col-md-3">
            <Form.Group>
              <Form.Label>Категория</Form.Label>
              <Form.Select 
                value={filterCategory} 
                onChange={(e) => setFilterCategory(e.target.value)}
              >
                <option value="">Все категории</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </Form.Select>
            </Form.Group>
          </div>
          <div className="col-md-3">
            <Form.Group>
              <Form.Label>Бренд</Form.Label>
              <Form.Select 
                value={filterBrand} 
                onChange={(e) => setFilterBrand(e.target.value)}
              >
                <option value="">Все бренды</option>
                {brands.map(brand => (
                  <option key={brand} value={brand}>{brand}</option>
                ))}
              </Form.Select>
            </Form.Group>
          </div>
          <div className="col-md-2 d-flex align-items-end">
            <Button 
              variant="outline-secondary" 
              onClick={() => {
                setFilterText('');
                setFilterCategory('');
                setFilterBrand('');
              }}
              className="w-100"
            >
              Сброс
            </Button>
          </div>
        </div>
      </div>

      <Table hover className="price-table">
        <thead>
          <tr>
            <th onClick={() => requestSort('name')}>
              Товар {getSortIcon('name')}
            </th>
            <th onClick={() => requestSort('price')}>
              Цена {getSortIcon('price')}
            </th>
            <th onClick={() => requestSort('change')}>
              Изменение {getSortIcon('change')}
            </th>
            <th onClick={() => requestSort('lastChangeDate')}>
              Последнее изменение {getSortIcon('lastChangeDate')}
            </th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {filteredProducts.map(product => {
            const latestPrice = product.prices[dates[0]];
            const previousPrice = product.prices[dates[1]];
            const change = formatPriceChange(latestPrice, previousPrice);
            const changed = hasPriceChanged(product);
            
            let lastChangeDate = null;
            let lastChangeValue = null;
            
            for (let i = 0; i < dates.length - 1; i++) {
              const currentPrice = product.prices[dates[i]];
              const nextPrice = product.prices[dates[i + 1]];
              if (currentPrice && nextPrice && Math.abs(currentPrice - nextPrice) > 0.01) {
                lastChangeDate = dates[i];
                lastChangeValue = currentPrice;
                break;
              }
            }

            return (
              <tr 
                key={product.code}
                className={highlightChanges && changed ? 'price-changed' : ''}
              >
                <td>
                  <div className="product-name" title={product.name}>
                    {product.name || 'Неизвестный товар'}
                  </div>
                  <div className="product-code">Код: {product.code}</div>
                  {product.brand && product.brand !== 'Без бренда' && (
                    <Badge bg="secondary" className="me-1">{product.brand}</Badge>
                  )}
                  {product.category && product.category !== 'Товары' && (
                    <Badge bg="info">{product.category}</Badge>
                  )}
                </td>
                <td>
                  {latestPrice ? (
                    <span className="price-value">{latestPrice.toFixed(2)} ₽</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  <span className={`price-change ${change.class}`}>
                    {change.text}
                  </span>
                </td>
                <td>
                  {lastChangeDate ? (
                    <div className="last-update">
                      {new Date(lastChangeDate).toLocaleDateString('ru-RU', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                      <br />
                      <small>{lastChangeValue?.toFixed(2)} ₽</small>
                    </div>
                  ) : (
                    <span className="text-muted">Нет изменений</span>
                  )}
                </td>
                <td>
                  {product.link && (
                    <a 
                      href={`https://www.21vek.by${product.link}`} 
                      target="_blank" 
                      rel="noreferrer"
                      className="btn btn-sm btn-outline-primary"
                    >
                      <FaExternalLinkAlt className="me-1" />
                      На сайт
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {filteredProducts.length === 0 && (
        <div className="text-center py-4">
          <p className="text-muted">Нет товаров, соответствующих фильтрам</p>
        </div>
      )}

      <div className="hunter-footer">
        <p>
          Price Hunter © 2026 | Данные обновляются каждый час с 21vek.by<br />
          <a href="#">О проекте</a> • <a href="#">GitHub</a> • <a href="#">API</a>
        </p>
      </div>
    </div>
  );
};

export default PriceTable;
