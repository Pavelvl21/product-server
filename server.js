import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting server...');
console.log('📡 PORT:', PORT);
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);

app.get('/', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});