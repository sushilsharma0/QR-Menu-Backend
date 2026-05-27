const { logger } = require("../utils/logger");
const { error } = require("../utils/apiResponse");

const errorHandler = (err, req, res, next) => {
  logger.error(`Error: ${err.message}`, {
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
  });

  const isFileSizeError = err?.code === "LIMIT_FILE_SIZE";
  const isValidationError = err?.name === "ValidationError";
  const statusCode = isFileSizeError ? 413 : isValidationError ? 400 : err.statusCode || 500;
  const maxMb = err?.limit ? Math.ceil(err.limit / (1024 * 1024)) : null;
  const message = isFileSizeError
    ? `File size must be less than ${maxMb || 5} MB`
    : isValidationError
      ? err.message
      : statusCode >= 500
        ? "Internal Server Error"
        : err.message || "Request failed";

  return error(res, message, statusCode);
};

module.exports = errorHandler;
