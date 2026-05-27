require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Platform = require('./src/models/platform/Platform');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/qr-menu-saas';
const isProduction = process.env.NODE_ENV === 'production';

function generateSeedPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);

    if (process.argv.includes('--reset')) {
      await Platform.deleteMany({});
      console.log('Cleared existing platform users');
    }

    const seedEmail = process.env.SEED_SUPERADMIN_EMAIL || (isProduction ? '' : 'superadmin@qrmenu.local');
    const seedPassword = process.env.SEED_SUPERADMIN_PASSWORD || (isProduction ? '' : generateSeedPassword());

    if (!seedEmail || !seedPassword) {
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
        isActive: true
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
  } catch (error) {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
  process.exit(process.exitCode ?? 0);
}

seed();
