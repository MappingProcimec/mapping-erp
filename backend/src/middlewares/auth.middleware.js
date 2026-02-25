const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../shared/errors/AppError');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Token no proporcionado'));
  }
  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'mapping-erp' });
    next();
  } catch (error) {
    next(error);
  }
};

const requireRole = (allowedRoles) => {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    if (!roles.includes(req.user?.rol)) {
      return next(new ForbiddenError(`Se requiere rol: ${roles.join(' o ')}`));
    }
    next();
  };
};

module.exports = { authMiddleware, requireRole };