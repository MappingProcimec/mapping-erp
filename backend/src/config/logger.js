const isDev = process.env.NODE_ENV !== 'production';

const logger = {
  info:  (...args) => console.log('[INFO]',  new Date().toISOString(), ...args),
  warn:  (...args) => console.warn('[WARN]',  new Date().toISOString(), ...args),
  error: (...args) => console.error('[ERROR]', new Date().toISOString(), ...args),
  debug: (...args) => isDev && console.log('[DEBUG]', new Date().toISOString(), ...args),
};

const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
};

module.exports = { logger, requestLogger };
