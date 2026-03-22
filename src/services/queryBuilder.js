export class SafeQueryBuilder {
  constructor() {
    this.params = [];
    this.conditions = [];
    this.joins = [];
  }
  
  addCondition(condition, ...values) {
    if (values.length > 0 && (values[0] === undefined || values[0] === null || (Array.isArray(values[0]) && values[0].length === 0))) {
      return this;
    }
    this.conditions.push(condition);
    this.params.push(...values);
    return this;
  }
  
  addLikeCondition(field, value) {
    if (value && value.trim()) {
      this.conditions.push(`${field} LIKE ?`);
      this.params.push(`%${value.toLowerCase()}%`);
    }
    return this;
  }
  
  addInCondition(field, values) {
    if (values && Array.isArray(values) && values.length > 0) {
      const placeholders = values.map(() => '?').join(',');
      this.conditions.push(`${field} IN (${placeholders})`);
      this.params.push(...values);
    }
    return this;
  }
  
  addJoin(joinType, table, condition) {
    this.joins.push(`${joinType} JOIN ${table} ON ${condition}`);
    return this;
  }
  
  buildWhere() {
    if (this.conditions.length === 0) {
      return { whereClause: '', params: [] };
    }
    return {
      whereClause: 'WHERE ' + this.conditions.join(' AND '),
      params: this.params
    };
  }
  
  buildFullQuery(select, from, orderBy = '', limit = null, offset = null) {
    const { whereClause, params } = this.buildWhere();
    const joinsClause = this.joins.length ? ' ' + this.joins.join(' ') : '';
    
    let query = `${select} FROM ${from}${joinsClause} ${whereClause}`;
    
    if (orderBy) {
      query += ` ${orderBy}`;
    }
    
    if (limit !== null) {
      query += ` LIMIT ?`;
      params.push(limit);
    }
    
    if (offset !== null) {
      query += ` OFFSET ?`;
      params.push(offset);
    }
    
    return { sql: query.trim(), params };
  }
}

export function getOrderByClause(sort) {
  const orderMap = {
    'price_asc': 'ORDER BY CAST(p.last_price AS REAL) ASC, p.code',
    'price_desc': 'ORDER BY CAST(p.last_price AS REAL) DESC, p.code',
    'name_asc': 'ORDER BY p.name_lower ASC, p.code',
    'name_desc': 'ORDER BY p.name_lower DESC, p.code',
    'default': 'ORDER BY p.last_update DESC, p.code'
  };
  return orderMap[sort] || orderMap.default;
}