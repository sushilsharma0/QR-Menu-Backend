const cron = require('node-cron');
const subscriptionService = require('./subscriptionService');
const backupService = require('./backupService');
const { logger } = require('../utils/logger');

class CronService {
  start() {
    // Check expired packages every 5 minutes.
    cron.schedule('*/5 * * * *', async () => {
      try {
        await subscriptionService.autoRenewExpiringSubscriptions();
        logger.info('Subscription check completed');
      } catch (error) {
        logger.error('Subscription check error:', error);
      }
    });

    // Run due restaurant backup schedules and retention cleanup.
    cron.schedule('*/15 * * * *', async () => {
      try {
        await backupService.runDueSchedules();
        logger.info('Backup schedule check completed');
      } catch (error) {
        logger.error('Backup schedule check error:', error);
      }
    });

    logger.info('Cron jobs initialized');
  }
}

module.exports = new CronService().start;
