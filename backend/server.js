// backend/server.js
require('dotenv').config();
const app = require('./src/app');
const { logger } = require('./src/config/logger');

// Railway inyecta PORT como variable de entorno
const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 API corriendo en puerto ${PORT} [${process.env.NODE_ENV}]`);
});

const shutdown = (signal) => {
  logger.warn(`Señal ${signal}. Cerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));