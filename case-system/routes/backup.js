const express = require('express');
const router  = express.Router();
const { requireAuth, requireOwner } = require('../middleware/auth');
const gdrive  = require('../lib/gdrive');
const backup  = require('../lib/db-backup');

// 立即備份到 Google Drive（老闆專屬）
router.post('/run', requireAuth, requireOwner, async (req, res) => {
  try { const r = await backup.runBackup(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 列出最近的備份
router.get('/list', requireAuth, requireOwner, async (req, res) => {
  try { const r = await gdrive.listBackups(30); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 直接下載一份即時資料庫快照到本機
router.get('/download', requireAuth, requireOwner, (req, res) => {
  try {
    const { name, buf } = backup.snapshotBuffer();
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
