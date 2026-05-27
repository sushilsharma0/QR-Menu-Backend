const crypto = require('crypto');
const path = require('path');
const JSZip = require('jszip');
const {
  BACKUP_VERSION,
  SCHEMA_VERSION,
  ENCRYPTION_VERSION,
  MAGIC_LEGACY,
  MAGIC,
  SUPPORTED_BACKUP_VERSIONS,
} = require('../../constants/backupConstants');

function encryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'development-backup-key-change-me';
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function hmacKey() {
  return process.env.BACKUP_SIGNING_KEY || process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'development-backup-signing-key';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sign(value) {
  return crypto.createHmac('sha256', hmacKey()).update(value).digest('hex');
}

function detectMagic(text) {
  if (text.startsWith(MAGIC)) return MAGIC;
  if (text.startsWith(MAGIC_LEGACY)) return MAGIC_LEGACY;
  return null;
}

async function encryptZip(zipBuffer, manifest) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = {
    magic: 'QRBACKUP',
    algorithm: 'AES-256-GCM',
    encryptionVersion: ENCRYPTION_VERSION,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    checksum: sha256(zipBuffer),
    manifestSignature: sign(JSON.stringify(manifest)),
    ciphertext: encrypted.toString('base64'),
  };
  envelope.envelopeSignature = sign(
    `${envelope.iv}.${envelope.authTag}.${envelope.checksum}.${envelope.manifestSignature}.${envelope.ciphertext}`,
  );
  return Buffer.from(MAGIC + JSON.stringify(envelope), 'utf8');
}

async function decryptPackage(buffer) {
  const maxUpload = Number(process.env.BACKUP_MAX_UPLOAD_BYTES || 250 * 1024 * 1024);
  if (buffer.length > maxUpload) throw new Error('Backup file exceeds maximum upload size');

  const text = buffer.toString('utf8');
  const magicUsed = detectMagic(text);
  if (!magicUsed) throw new Error('Invalid or corrupted backup file: unrecognized format');

  const envelope = JSON.parse(text.slice(magicUsed.length));
  const expected = sign(
    `${envelope.iv}.${envelope.authTag}.${envelope.checksum}.${envelope.manifestSignature}.${envelope.ciphertext}`,
  );
  if (expected !== envelope.envelopeSignature) {
    throw new Error('Backup tamper detection failed: signature verification rejected');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const zipBuffer = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);

  const maxUnzipped = Number(process.env.BACKUP_MAX_UNZIPPED_BYTES || 500 * 1024 * 1024);
  if (zipBuffer.length > maxUnzipped) throw new Error('Backup payload exceeds restore safety limit (zip bomb protection)');

  if (sha256(zipBuffer) !== envelope.checksum) {
    throw new Error('Backup integrity check failed: checksum mismatch');
  }

  return { zipBuffer, envelope, magicUsed };
}

async function buildZip({ metadata, manifest, data, mediaRefs = [] }) {
  const zip = new JSZip();
  zip.file('metadata.json', JSON.stringify(metadata, null, 2));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('media/references.json', JSON.stringify(mediaRefs, null, 2));
  for (const [key, value] of Object.entries(data)) {
    const json = JSON.stringify(value ?? (Array.isArray(value) ? [] : null), null, 2);
    if (json.length > 50 * 1024 * 1024) throw new Error(`Collection ${key} exceeds per-file safety limit`);
    zip.file(`collections/${key}.json`, json);
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function safeParseJson(str, label) {
  if (typeof str !== 'string' || str.length > 50 * 1024 * 1024) {
    throw new Error(`Invalid ${label}: oversized or malformed`);
  }
  const trimmed = str.trim();
  if (/^[\s]*[<\u0000]/.test(trimmed) || /<script/i.test(trimmed)) {
    throw new Error(`Invalid ${label}: rejected potentially malicious content`);
  }
  return JSON.parse(trimmed);
}

async function loadBackupPayload(buffer) {
  const { zipBuffer, envelope } = await decryptPackage(buffer);
  const zip = await JSZip.loadAsync(zipBuffer);

  const fileCount = Object.keys(zip.files).filter((n) => !zip.files[n].dir).length;
  if (fileCount > Number(process.env.BACKUP_MAX_ZIP_ENTRIES || 500)) {
    throw new Error('Backup archive contains too many entries');
  }

  const metadataFile = zip.file('metadata.json');
  const manifestFile = zip.file('manifest.json');
  if (!metadataFile || !manifestFile) throw new Error('Incomplete backup: missing metadata or manifest');

  const metadata = safeParseJson(await metadataFile.async('string'), 'metadata');
  const manifest = safeParseJson(await manifestFile.async('string'), 'manifest');

  if (sign(JSON.stringify(manifest)) !== envelope.manifestSignature) {
    throw new Error('Backup manifest signature verification failed');
  }

  const version = manifest.backupVersion || metadata.backupVersion;
  if (!SUPPORTED_BACKUP_VERSIONS.has(version)) {
    throw new Error(`Unsupported backup version: ${version}`);
  }

  const data = {};
  for (const fileName of Object.keys(zip.files)) {
    if (!fileName.startsWith('collections/') || !fileName.endsWith('.json')) continue;
    if (fileName.includes('..') || path.basename(fileName) !== fileName.split('/').pop()) {
      throw new Error('Invalid backup path in archive');
    }
    const key = path.basename(fileName, '.json');
    data[key] = safeParseJson(await zip.file(fileName).async('string'), key);
  }

  let mediaRefs = [];
  const mediaFile = zip.file('media/references.json');
  if (mediaFile) {
    mediaRefs = safeParseJson(await mediaFile.async('string'), 'media references');
  }

  return {
    metadata,
    manifest,
    data,
    mediaRefs,
    checksum: envelope.checksum,
  };
}

function buildManifestExtras(collected, restaurantId, branchCount = 0) {
  return {
    backupVersion: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    encryptionVersion: ENCRYPTION_VERSION,
    restaurantId: String(restaurantId),
    branchCount,
    totalCollections: Object.keys(collected.collectionCounts || {}).length,
    totalDocuments: collected.documentCount || 0,
    checksumValidationHash: sha256(JSON.stringify(collected.collectionCounts || {})),
    includedSections: collected.included,
    collectionCounts: collected.collectionCounts,
    documentCount: collected.documentCount,
  };
}

module.exports = {
  encryptZip,
  decryptPackage,
  buildZip,
  loadBackupPayload,
  buildManifestExtras,
  sha256,
  sign,
  detectMagic,
};
