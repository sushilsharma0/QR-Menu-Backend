const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { buildSignedFileUrl } = require('./fileAccessToken');

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const allowedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function normalizeDeclaredMime(mimetype) {
  const m = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
  return m;
}

const extensionByMime = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
const blockedExtensions = new Set(['.exe', '.php', '.html', '.htm', '.js', '.mjs', '.svg', '.sh', '.bat', '.cmd']);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function uploadRoot() {
  return path.resolve(process.env.SECURE_UPLOAD_PATH || path.join(process.cwd(), 'secure_uploads'));
}

function safeFolder(folder) {
  const cleaned = String(folder || 'uploads').replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+/, '');
  const normalized = path.posix.normalize(cleaned || 'uploads');
  if (normalized.startsWith('../')) return 'uploads';
  return normalized;
}

/** Detect real MIME from magic bytes (declared Content-Type is often wrong for .jpg/.png). */
function detectContentMime(chunk) {
  if (!Buffer.isBuffer(chunk) || chunk.length < 4) return null;
  if (chunk[0] === 0xff && chunk[1] === 0xd8 && chunk[2] === 0xff) return 'image/jpeg';
  if (
    chunk.length >= 8
    && chunk.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    chunk.length >= 12
    && chunk.subarray(0, 4).toString('ascii') === 'RIFF'
    && chunk.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (chunk.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (chunk.length >= 12 && chunk.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = chunk.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.includes('heic') || brand.includes('heix') || brand.includes('hevc') || brand.includes('mif1')) {
      return 'image/heic';
    }
    if (brand.includes('avif') || brand.includes('avis')) return 'image/avif';
  }
  return null;
}

function isAllowedFileContent(declaredMimetype, chunk) {
  const detected = detectContentMime(chunk);
  if (!detected || !allowedMimeTypes.has(detected)) {
    if (detected === 'image/heic' || detected === 'image/avif') return false;
    return false;
  }
  const declared = normalizeDeclaredMime(declaredMimetype);
  if (!allowedMimeTypes.has(declared)) return false;
  if (detected === declared) return true;
  // Browsers often label PNG/WebP as image/jpeg when the extension is .jpg
  if (allowedImageMimeTypes.has(detected) && allowedImageMimeTypes.has(declared)) return true;
  return declared === 'application/pdf' && detected === 'application/pdf';
}

function resolveStoredMime(declaredMimetype, chunk) {
  const detected = detectContentMime(chunk);
  if (detected && allowedMimeTypes.has(detected)) return detected;
  return normalizeDeclaredMime(declaredMimetype);
}

function validateUploadMetadata(file) {
  const original = path.basename(String(file.originalname || ''));
  const ext = path.extname(original).toLowerCase();
  const mime = normalizeDeclaredMime(file.mimetype);
  if (!allowedMimeTypes.has(mime)) throw new Error('Only JPG, JPEG, PNG, WEBP, and PDF files are allowed');
  if (!allowedExtensions.has(ext) || blockedExtensions.has(ext)) throw new Error('This file extension is not allowed');
  file.mimetype = mime;
}

function scanFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return reject(readErr);
      if (data.includes(Buffer.from(EICAR))) return reject(new Error('Virus scan failed'));

      if (String(process.env.CLAMAV_ENABLED || '').toLowerCase() !== 'true') return resolve();
      execFile(process.env.CLAMSCAN_PATH || 'clamscan', ['--no-summary', filePath], { timeout: 30000 }, (err) => {
        if (err) return reject(new Error('Virus scan failed'));
        return resolve();
      });
    });
  });
}

function uploadValidationError(header) {
  const detected = detectContentMime(header);
  if (detected === 'image/heic' || detected === 'image/avif') {
    return new Error('HEIC/AVIF images are not supported. Please save as JPG, PNG, or WEBP.');
  }
  return new Error('Uploaded file content does not match its declared type. Use JPG, PNG, or WEBP.');
}

function createSecureUploadStorage(getFolder) {
  return {
    async _handleFile(req, file, cb) {
      let targetPath = '';
      const unlinkTarget = async () => {
        if (targetPath) await fsp.unlink(targetPath).catch(() => {});
      };
      try {
        validateUploadMetadata(file);
        const folder = safeFolder(typeof getFolder === 'function' ? getFolder(req, file) : getFolder);
        const root = uploadRoot();
        const destination = path.resolve(root, folder);
        if (!destination.startsWith(root + path.sep)) throw new Error('Invalid upload path');
        await fsp.mkdir(destination, { recursive: true });

        const chunks = [];
        let bytes = 0;

        file.stream.on('data', (chunk) => {
          chunks.push(chunk);
          bytes += chunk.length;
        });

        file.stream.on('error', async (err) => {
          await unlinkTarget();
          cb(err);
        });

        file.stream.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const header = buffer.subarray(0, Math.min(buffer.length, 16));
            if (!isAllowedFileContent(file.mimetype, header)) {
              throw uploadValidationError(header);
            }
            const storedMime = resolveStoredMime(file.mimetype, header);
            const ext = extensionByMime[storedMime];
            if (!ext) throw new Error('Unsupported file type');
            const fileName = `${crypto.randomUUID()}${ext}`;
            const relativePath = path.posix.join(folder, fileName);
            targetPath = path.resolve(destination, fileName);
            if (!targetPath.startsWith(root + path.sep)) throw new Error('Invalid upload path');

            await fsp.writeFile(targetPath, buffer, { mode: 0o600 });
            await scanFile(targetPath);
            return cb(null, {
              path: buildSignedFileUrl(req, relativePath),
              filename: relativePath,
              destination,
              securePath: targetPath,
              size: bytes,
              mimetype: storedMime,
              originalname: path.basename(String(file.originalname || 'upload')),
            });
          } catch (err) {
            await unlinkTarget();
            return cb(err);
          }
        });
      } catch (err) {
        await unlinkTarget();
        return cb(err);
      }
    },

    _removeFile(req, file, cb) {
      if (!file?.securePath) return cb(null);
      fs.unlink(file.securePath, () => cb(null));
    },
  };
}

module.exports = {
  createSecureUploadStorage,
  allowedMimeTypes,
  allowedExtensions,
  normalizeDeclaredMime,
};
