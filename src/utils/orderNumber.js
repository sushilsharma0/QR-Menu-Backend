const crypto = require('crypto');
const mongoose = require('mongoose');

/** Public order reference format: Q + 3 digits + R + 3 digits + R + 3 digits (e.g. Q042R918R305) */
const ORDER_NUMBER_PATTERN = /^Q\d{3}R\d{3}R\d{3}$/;

function randomThreeDigits() {
  return String(crypto.randomInt(0, 1000)).padStart(3, '0');
}

function buildOrderNumberCandidate() {
  return `Q${randomThreeDigits()}R${randomThreeDigits()}R${randomThreeDigits()}`;
}

function isValidOrderNumber(value) {
  return ORDER_NUMBER_PATTERN.test(String(value || '').trim());
}

/**
 * Generate a unique order number across CustomerOrder and legacy Order collections.
 */
async function generateUniqueOrderNumber({ maxAttempts = 32 } = {}) {
  const models = [];
  try {
    models.push(mongoose.model('CustomerOrder'));
  } catch {
    /* model not registered yet */
  }
  try {
    models.push(mongoose.model('Order'));
  } catch {
    /* optional legacy model */
  }

  if (!models.length) {
    throw new Error('No order models registered for order number generation');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = buildOrderNumberCandidate();
    // eslint-disable-next-line no-await-in-loop
    const hits = await Promise.all(
      models.map((Model) => Model.exists({ orderNumber: candidate })),
    );
    if (!hits.some(Boolean)) return candidate;
  }

  throw new Error('Failed to generate a unique order number');
}

module.exports = {
  ORDER_NUMBER_PATTERN,
  buildOrderNumberCandidate,
  isValidOrderNumber,
  generateUniqueOrderNumber,
};
