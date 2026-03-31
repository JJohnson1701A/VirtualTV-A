const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const UPLOAD_DIR = path.join(__dirname, '../public/images');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Accepted image MIME types + extensions
const ACCEPTED_MIME = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml',
  'image/gif', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic',
  'image/heif', 'image/jfif', 'image/pjpeg',
];
const ACCEPTED_EXT = [
  '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.bmp',
  '.tiff', '.tif', '.avif', '.heic', '.heif', '.jfif',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — posters can be large
  fileFilter: function(req, file, cb) {
    const ext  = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();
    const ok   = ACCEPTED_MIME.indexOf(mime) !== -1 || ACCEPTED_EXT.indexOf(ext) !== -1;
    if (ok) cb(null, true);
    else cb(new Error('Unsupported image format: ' + (ext || mime)));
  },
});

router.post('/image', upload.single('file'), function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Preserve original extension; fall back to .jpg
    var ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    var filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    var destPath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(destPath, req.file.buffer);

    res.json({
      file_url:    '/images/' + filename,
      filename:    filename,
      size_bytes:  req.file.size,
      mime_type:   req.file.mimetype,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// multer error handler (invalid file type, file too large)
router.use(function(err, req, res, next) {
  if (err && err.message) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;
