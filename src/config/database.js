const mongoose = require('mongoose');
const { MONGODB_URI } = require('./env');
const { logger } = require('../utils/logger');
const InventoryItem = require('../models/restaurant/InventoryItem');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4
    });
    
    logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);

    try {
      await InventoryItem.syncIndexes();
      logger.info('InventoryItem.syncIndexes() completed (drops legacy indexes not in schema)');
    } catch (syncErr) {
      logger.warn('InventoryItem.syncIndexes skipped or failed:', syncErr.message);
    }
    
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    return conn;
  } catch (error) {
    logger.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;