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
