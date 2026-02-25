const { ValidationError } = require('../shared/errors/AppError');

const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      const messages = error.details.map(d => d.message).join('; ');
      return next(new ValidationError(messages));
    }
    req[source] = value;
    next();
  };
};

module.exports = { validate };