import Joi from 'joi';

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  JWT_SECRET: Joi.string().required(),
  SECRET_KEY: Joi.string().required(),
  TURSO_URL: Joi.string().required(),
  TURSO_TOKEN: Joi.string().required(),
  TELEGRAM_BOT_TOKEN: Joi.string().optional(),
  TELEGRAM_CHAT_ID: Joi.string().optional(),
  API_URL: Joi.string().default('http://localhost:3000'),
  EMAIL_USER: Joi.string().optional(),
  EMAIL_PASS: Joi.string().optional(),
  EMAIL_FROM: Joi.string().optional()
}).unknown();

const { error, value: config } = envSchema.validate(process.env);

if (error) {
  console.error('❌ Ошибка валидации переменных окружения:', error.message);
  process.exit(1);
}

export { config };