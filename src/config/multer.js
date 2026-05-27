const multer = require('multer');
const path = require('path');
const { MAX_FILE_SIZE } = require('./env');
const cloudinary = require('./cloudinary');
const createCloudinaryStorage = require('../utils/cloudinaryMulterStorage');
const {
  createSecureUploadStorage,
  allowedMimeTypes,
  allowedExtensions,
  normalizeDeclaredMime,
} = require('../utils/secureUploadStorage');

const CLOUDINARY_PUBLIC_IMAGE_FIELDS = new Set([
  'logo',
  'backgroundPhoto',
  'favicon',
  'brandBackgroundImage',
  'landingLogo',
  'image',
  'banner',
]);

const SECURE_LOCAL_FIELDS = new Set([
  'profilePhoto',
  'idDocument',
  'panDocument',
  'businessRegistrationDoc',
  'addressProof',
  'employeePhoto',
  'paymentProof',
  'receiptImage',
  'invoiceDocument',
  'qrCodeImage',
  'profileImage',
]);

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const folderForField = (req, file) => {
  if (['profilePhoto', 'idDocument', 'panDocument', 'businessRegistrationDoc', 'addressProof'].includes(file.fieldname)) return 'kyc';
  if (file.fieldname === 'employeePhoto') return 'employees';
  if (file.fieldname === 'paymentProof') return 'payment-proofs';
  if (['receiptImage', 'invoiceDocument'].includes(file.fieldname)) return 'finance';
  if (file.fieldname === 'qrCodeImage') return 'platform-payments';
  if (file.fieldname === 'profileImage') return 'platform-profiles';
  throw new Error(`Unsupported secure upload field: ${file.fieldname}`);
};

const cloudinaryFolderForField = (fieldname) => {
  if (fieldname === 'landingLogo') return 'platform-branding';
  if (['logo', 'backgroundPhoto', 'favicon', 'brandBackgroundImage'].includes(fieldname)) return 'restaurant-branding';
  if (fieldname === 'banner') return 'branch-branding';
  if (fieldname === 'image') return 'menu-images';
  return 'public-images';
};

const isCloudinaryConfigured = () =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const secureStorage = createSecureUploadStorage(folderForField);
const cloudinaryStorage = createCloudinaryStorage(cloudinary, async (req, file) => ({
  folder: `qr-menu/${cloudinaryFolderForField(file.fieldname)}`,
  resource_type: 'image',
  type: 'upload',
  overwrite: false,
  use_filename: false,
  unique_filename: true,
}));

const splitStorage = {
  _handleFile(req, file, cb) {
    if (CLOUDINARY_PUBLIC_IMAGE_FIELDS.has(file.fieldname)) {
      if (!isCloudinaryConfigured()) {
        return cb(new Error('Cloudinary is not configured for public image uploads'));
      }
      return cloudinaryStorage._handleFile(req, file, cb);
    }

    if (!SECURE_LOCAL_FIELDS.has(file.fieldname)) {
      return cb(new Error(`Unsupported upload field: ${file.fieldname}`));
    }

    return secureStorage._handleFile(req, file, cb);
  },

  _removeFile(req, file, cb) {
    if (file?.cloudinary) return cloudinaryStorage._removeFile(req, file, cb);
    return secureStorage._removeFile(req, file, cb);
  },
};

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = normalizeDeclaredMime(file.mimetype);
  file.mimetype = mime;

  if (CLOUDINARY_PUBLIC_IMAGE_FIELDS.has(file.fieldname)) {
    if (IMAGE_MIME_TYPES.has(mime) && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return cb(null, true);
    return cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed for public media uploads'));
  }

  if (!SECURE_LOCAL_FIELDS.has(file.fieldname)) {
    return cb(new Error(`Unsupported upload field: ${file.fieldname}`));
  }

  if (allowedMimeTypes.has(mime) && allowedExtensions.has(ext)) return cb(null, true);
  return cb(new Error('Only JPG, JPEG, PNG, WEBP, and PDF files are allowed'));
};

const upload = multer({
  storage: splitStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

upload.CLOUDINARY_PUBLIC_IMAGE_FIELDS = CLOUDINARY_PUBLIC_IMAGE_FIELDS;
upload.SECURE_LOCAL_FIELDS = SECURE_LOCAL_FIELDS;

module.exports = upload;
