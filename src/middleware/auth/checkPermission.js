const { forbidden } = require('../../utils/apiResponse');

const checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return forbidden(res, 'Authentication required');
    }
    
    if (req.user.role === 'super_admin') {
      return next();
    }
    
    if (req.user.permissions && req.user.permissions[permission]) {
      return next();
    }
    
    return forbidden(res, `Permission denied: ${permission} required`);
  };
};

module.exports = checkPermission;