const mongoose = require('mongoose');

function readString(value, { max = 100, allowed = null } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (allowed && !allowed.includes(trimmed)) return null;
  return trimmed;
}

function readNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = false, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (integer && !Number.isInteger(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

function readObjectId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!mongoose.Types.ObjectId.isValid(trimmed)) return null;
  return new mongoose.Types.ObjectId(trimmed);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSearchRegex(value, { max = 80 } = {}) {
  const text = readString(value, { max });
  if (!text) return null;
  return { $regex: escapeRegex(text), $options: 'i' };
}

module.exports = {
  readString,
  readNumber,
  readObjectId,
  escapeRegex,
  readSearchRegex,
};
