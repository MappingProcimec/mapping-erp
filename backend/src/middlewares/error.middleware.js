const { AppError } = require('../shared/errors/AppError');

const errorHandler = (err, req, res, next) => {
  console.error({
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: 'error', code: err.code, message: err.message,
    });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ status: 'error', code: 'INVALID_TOKEN', message: 'Token inválido o expirado' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ status: 'error', code: 'DUPLICATE_ENTRY', message: 'Ya existe un registro con esos datos' });
  }
  return res.status(500).json({
    status: 'error', code: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Error interno del servidor',
  });
};

const setupProcessErrorHandlers = () => {
  process.on('unhandledRejection', (reason) => { console.error('UNHANDLED REJECTION:', reason); process.exit(1); });
  process.on('uncaughtException',  (error)  => { console.error('UNCAUGHT EXCEPTION:', error);  process.exit(1); });
};

module.exports = { errorHandler, setupProcessErrorHandlers };