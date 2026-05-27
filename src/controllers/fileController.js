const path = require('path');
const fs = require('fs');
const { verifyFileToken } = require('../utils/fileAccessToken');
const { unauthorized, error } = require('../utils/apiResponse');

const mimeByExt = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const getUploadRoot = () => path.resolve(process.env.SECURE_UPLOAD_PATH || path.join(process.cwd(), 'secure_uploads'));

const serveSignedFile = (req, res) => {
  const relativePath = verifyFileToken(req.params.token);
  if (!relativePath) return unauthorized(res, 'File link is invalid or expired');

  const root = getUploadRoot();
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root + path.sep)) return error(res, 'Invalid file path', 400);
  if (!fs.existsSync(filePath)) return error(res, 'File not found', 404);

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', mimeByExt[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${ext === '.pdf' ? 'inline' : 'inline'}; filename="${path.basename(filePath)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return fs.createReadStream(filePath).pipe(res);
};

module.exports = { serveSignedFile };
