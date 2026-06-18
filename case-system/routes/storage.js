const express = require('express');
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('只支援圖片格式'));
    cb(null, true);
  },
});

router.post('/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇圖片' });
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'huixin', resource_type: 'image', transformation: [{ width: 1200, crop: 'limit', quality: 'auto' }] },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });
    res.json({ ok: true, url: result.secure_url, public_id: result.public_id });
  } catch (e) {
    res.status(500).json({ error: '上傳失敗：' + e.message });
  }
});

const ALLOWED_DOC_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
];

const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOC_TYPES.includes(file.mimetype)) return cb(new Error('不支援此檔案格式，請上傳 PDF、Excel、Word 或圖片'));
    cb(null, true);
  },
});

router.post('/upload-doc', requireAuth, uploadDoc.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  try {
    // multer 預設把 multipart 檔名當 latin1 解碼，中文會亂碼 → 還原為 UTF-8
    const origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const isImage = req.file.mimetype.startsWith('image/');
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: 'huixin-docs',
          resource_type: isImage ? 'image' : 'raw',
          public_id: `${Date.now()}_${origName.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
          use_filename: false,
        },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });
    res.json({ ok: true, url: result.secure_url, public_id: result.public_id, filename: origName });
  } catch (e) {
    res.status(500).json({ error: '上傳失敗：' + e.message });
  }
});

router.delete('/delete', requireAuth, async (req, res) => {
  const { public_id } = req.body;
  if (!public_id) return res.status(400).json({ error: '缺少 public_id' });
  try {
    await cloudinary.uploader.destroy(public_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
