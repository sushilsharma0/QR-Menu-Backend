const { validationResult, body, param, query } = require('express-validator');
const { validationError } = require('../../utils/apiResponse');

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));
    
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }
    
    const formattedErrors = errors.array().map(err => ({
      field: err.param,
      message: err.msg
    }));
    
    return validationError(res, formattedErrors);
  };
};

const commonValidations = {
  email: body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  password: body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  id: param('id').isMongoId().withMessage('Invalid ID format'),
  page: query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  limit: query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
};

module.exports = { validate, commonValidations };