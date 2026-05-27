require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/database');
const { initSocket } = require('./src/services/socketService');
const { setSocketIO } = require('./src/services/realtimeBroadcastService');
const { logger } = require('./src/utils/logger');

const PORT = process.env.PORT || 5000;
// Bind all interfaces so phones on the same LAN can reach http://<PC-IP>:PORT
const HOST = process.env.HOST || '0.0.0.0';

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = initSocket(server);
setSocketIO(io);
app.set('io', io);

// Connect to Database
connectDB();

const { initRestoreQueue } = require('./src/queues/restoreQueue');
initRestoreQueue().catch((err) => {
  logger.warn('Restore queue init: %s', err.message);
});

// Start server
server.listen(PORT, HOST, () => {
  logger.info(`🚀 Server running on port ${PORT} (host ${HOST})`);
  logger.info(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔌 WebSocket ready for real-time updates`);
  logger.info(`📍 API URL: http://localhost:${PORT}/api`);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, closing server...`);
  server.close(async () => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Unhandled async errors. These are most commonly caused by third-party
// SDK calls (e.g. Cloudinary uploads timing out) where the SDK rejects a
// promise that nothing's awaiting. We used to call gracefulShutdown here,
// which exits the process — that turned every transient SDK hiccup into
// a full server crash + nodemon stall. In development we log and keep
// running; in production we exit so the process manager can restart us.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.error(`Unhandled Rejection: ${message}`);
  if (process.env.NODE_ENV === 'production') {
    gracefulShutdown('UNHANDLED_REJECTION');
  }
});

// Uncaught exceptions are more serious — the JS engine state may be
// corrupt. Always shut down, but still give in-flight requests a moment
// to drain via gracefulShutdown's server.close().
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

module.exports = { server, io };