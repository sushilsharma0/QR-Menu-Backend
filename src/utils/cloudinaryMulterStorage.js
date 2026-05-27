const { normalizeDeclaredMime } = require('./secureUploadStorage');

function uploadStream(cloudinary, file, params) {
  return new Promise(async (resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(params, (err, result) => {
      if (err) return reject(err);
      return resolve(result);
    });
    upload.on('error', reject);
    try {
      let checked = false;
      const pending = [];
      let pendingLength = 0;
      for await (const chunk of file.stream) {
        if (!checked) {
          pending.push(chunk);
          pendingLength += chunk.length;
          if (pendingLength < 12) {
            continue;
          }
          const header = Buffer.concat(pending, pendingLength);
          checked = true;
          if (!isAllowedFileContent(file.mimetype, header)) {
            upload.destroy();
            return reject(new Error('Uploaded file content does not match its declared type'));
          }
          for (const bufferedChunk of pending) {
            if (!upload.write(bufferedChunk)) {
              await new Promise((drainResolve) => upload.once('drain', drainResolve));
            }
          }
          pending.length = 0;
          continue;
        }
        if (!upload.write(chunk)) {
          await new Promise((drainResolve) => upload.once('drain', drainResolve));
        }
      }
      if (!checked) {
        const header = Buffer.concat(pending, pendingLength);
        if (!isAllowedFileContent(file.mimetype, header)) {
          upload.destroy();
          return reject(new Error('Uploaded file content does not match its declared type'));
        }
        for (const bufferedChunk of pending) {
          if (!upload.write(bufferedChunk)) {
            await new Promise((drainResolve) => upload.once('drain', drainResolve));
          }
        }
      }
      upload.end();
    } catch (err) {
      upload.destroy();
      return reject(err);
    }
  });
}

function isAllowedFileContent(mimetype, chunk) {
  if (!Buffer.isBuffer(chunk) || chunk.length < 4) return false;
  const normalizedMime = normalizeDeclaredMime(mimetype);
  if (normalizedMime === 'image/jpeg') return chunk[0] === 0xff && chunk[1] === 0xd8 && chunk[2] === 0xff;
  if (normalizedMime === 'image/png') return chunk.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (normalizedMime === 'image/webp') return chunk.subarray(0, 4).toString('ascii') === 'RIFF' && chunk.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function createCloudinaryStorage(cloudinary, getParams) {
  return {
    async _handleFile(req, file, cb) {
      try {
        if (!file.stream) return cb(new Error('File stream is missing'));
        const params = await getParams(req, file);
        const result = await uploadStream(cloudinary, file, params);
        return cb(null, {
          path: result.secure_url || result.url,
          filename: result.public_id,
          size: result.bytes,
          mimetype: normalizeDeclaredMime(file.mimetype),
          originalname: file.originalname,
          cloudinary: result,
          resource_type: params.resource_type,
        });
      } catch (err) {
        return cb(err);
      }
    },

    _removeFile(req, file, cb) {
      if (!file?.filename) return cb(null);
      cloudinary.uploader.destroy(file.filename, { resource_type: file.resource_type || 'image' }, () => cb(null));
    },
  };
}

module.exports = createCloudinaryStorage;
