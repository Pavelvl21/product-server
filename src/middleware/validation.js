import Joi from 'joi';

export const schemas = {
  email: Joi.object({
    email: Joi.string().email().required()
  }),
  
  register: Joi.object({
    username: Joi.string().email().required(),
    password: Joi.string()
      .min(8)
      .max(100)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/)
      .required()
      .messages({
        'string.pattern.base': 'Пароль должен содержать минимум 8 символов, буквы и цифры',
        'string.min': 'Пароль должен быть не менее 8 символов',
        'string.max': 'Пароль не должен превышать 100 символов',
        'any.required': 'Пароль обязателен'
      })
  }),
  
  login: Joi.object({
    username: Joi.string().email().required(),
    password: Joi.string().required()
  }),
  
  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string()
      .min(8)
      .max(100)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/)
      .required()
      .messages({
        'string.pattern.base': 'Новый пароль должен содержать минимум 8 символов, буквы и цифры',
        'string.min': 'Новый пароль должен быть не менее 8 символов',
        'string.max': 'Новый пароль не должен превышать 100 символов',
        'any.required': 'Новый пароль обязателен'
      })
  }),
  
  addCode: Joi.object({
    code: Joi.string().pattern(/^\d{1,12}$/).required()
  }),
  
  bulkAddCodes: Joi.object({
    codes: Joi.array().items(Joi.string().pattern(/^\d{1,12}$/)).min(1).max(100).required()
  })
};

export function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        error: 'Некорректные данные',
        details: error.details.map(d => d.message)
      });
    }
    req.validatedBody = value;
    next();
  };
}

export function sanitizeInput(str) {
  if (!str) return '';
  return str.replace(/[<>]/g, '');
}