import multer from 'multer';

const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxSizeMb = Number(process.env.MAX_IMAGE_SIZE_MB || 5);

export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxSizeMb * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedTypes.has(file.mimetype)) {
      return callback(new Error('Unsupported image type. Use PNG, JPG, WEBP, or GIF.'));
    }
    callback(null, true);
  }
});
