require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const connectDB = require('./src/config/database');
const Platform = require('./src/models/platform/Platform');

const isProduction = process.env.NODE_ENV === 'production';

function generateSeedPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function seed({ reset = false, allowMissingCredentials = false } = {}) {
  let ownsConnection = false;

  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
      ownsConnection = true;
    }

    if (reset) {
      await Platform.deleteMany({});
      console.log('Cleared existing platform users');
    }

    const seedEmail = process.env.SEED_SUPERADMIN_EMAIL || (isProduction ? '' : 'superadmin@qrmenu.local');
    const seedPassword = process.env.SEED_SUPERADMIN_PASSWORD || (isProduction ? '' : generateSeedPassword());

    if (!seedEmail || !seedPassword) {
      if (allowMissingCredentials) {
        console.warn('Skipping seed: SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD are not configured.');
        return { skipped: true };
      }
      throw new Error('Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD before running the seed script.');
    }

    const exists = await Platform.findOne({ email: seedEmail });
    let created = false;
    if (!exists) {
      await Platform.create({
        name: 'Super Admin',
        email: seedEmail,
        password: seedPassword,
        role: 'super_admin',
        isActive: true,
      });
      created = true;
      console.log('Super Admin created');
    }

    console.log('Seeding completed.');
    if (created && !process.env.SEED_SUPERADMIN_PASSWORD) {
      console.log(`Login: ${seedEmail} / ${seedPassword}`);
      console.log('Save this generated password now; it will not be shown again.');
    } else {
      console.log(`Login: ${seedEmail} / <configured password>`);
    }

    return { skipped: false, created };
  } catch (error) {
    console.error('Seed failed:', error.message);
    if (!allowMissingCredentials) {
      process.exitCode = 1;
    }
    throw error;
  } finally {
    if (ownsConnection) {
      await mongoose.connection.close();
    }
  }
}

if (require.main === module) {
  seed({ reset: process.argv.includes('--reset') })
    .then(() => process.exit(process.exitCode ?? 0))
    .catch(() => process.exit(process.exitCode ?? 1));
}

module.exports = { seed };
