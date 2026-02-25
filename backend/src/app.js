require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { errorHandler, setupProcessErrorHandlers } = require('./middlewares/error.middleware');
const { requestLogger } = require('./config/logger');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(requestLogger);

// Health check
app.get('/health', async (req, res) => {
  const { pool } = require('./shared/database/pool');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Mapping Ingeniería ERP API', version: '1.0.0' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.use(errorHandler);
setupProcessErrorHandlers();

module.exports = app;