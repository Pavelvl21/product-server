import Joi from 'joi';

export const schemas = {
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
  code: Joi.string().pattern(/^\d{1,12}$/).required(),
  codes: Joi.array().items(Joi.string().pattern(/^\d{1,12}$/)).min(1).max(100).required(),
  telegramUrl: Joi.string().uri().required(),
  telegramId: Joi.number().required(),
  categories: Joi.array().items(Joi.string()).min(1).required(),
  
  register: Joi.object({
    username: Joi.string().email().required(),
    password: Joi.string().min(6).max(100).required()
  }),
  
  login: Joi.object({
    username: Joi.string().email().required(),
    password: Joi.string().required()
  }),
  
  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(6).max(100).required()
  }),
  
  addCode: Joi.object({
    code: Joi.string().pattern(/^\d{1,12}$/).required()
  }),
  
  bulkAddCodes: Joi.object({
    codes: Joi.array().items(Joi.string().pattern(/^\d{1,12}$/)).min(1).max(100).required()
  }),
  
  updateUserCategories: Joi.object({
    telegramId: Joi.number().required(),
    categories: Joi.array().items(Joi.string()).required()
  }),
  
  approveUser: Joi.object({
    telegramId: Joi.number().required()
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