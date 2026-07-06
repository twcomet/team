const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const gdrive = require('../lib/gdrive');
const router = express.Router();

// 狀態（只有老闆）
router.get('/status', requireAuth, requireOwner, (req, res) => {
  res.json({ configured: gdrive.isConfigured(), connected: gdrive.isConnected() });
});

// 開始連接 → 導向 Google 同意畫面（只有老闆）
router.get('/connect', requireAuth, requireOwner, (req, res) => {
  if (!gdrive.isConfigured()) return res.status(500).send('伺服器尚未設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  req.session.gdrive_state = state;
  res.redirect(gdrive.authUrl(state));
});

// 中斷連接（只有老闆）
router.post('/disconnect', requireAuth, requireOwner, (req, res) => {
  gdrive.disconnect();
  res.json({ ok: true });
});

// Google 回呼（Google 導回來，帶 code + state）
router.get('/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/gdrive-connect?r=denied');
    if (!req.query.state || req.query.state !== req.session.gdrive_state) {
      return res.redirect('/gdrive-connect?r=badstate');
    }
    req.session.gdrive_state = null;
    await gdrive.exchangeCode(req.query.code);
    res.redirect('/gdrive-connect?r=connected');
  } catch (e) {
    res.redirect('/gdrive-connect?r=error');
  }
});

// 為某案件建立（或取得已建立的）雲端資料夾
router.post('/case/:id/folder', requireAuth, async (req, res) => {
  try {
    const c = db.prepare(`
      SELECT c.id, c.case_number, c.title, c.drive_folder_url, cl.name AS client_name
      FROM cases c LEFT JOIN clients cl ON c.client_id = cl.id WHERE c.id = ?
    `).get(req.params.id);
    if (!c) return res.status(404).json({ error: '找不到案件' });
    if (c.drive_folder_url) return res.json({ url: c.drive_folder_url, existed: true });
    if (!gdrive.isConnected()) return res.status(400).json({ error: '系統尚未連接 Google 雲端，請老闆先到「雲端整合」連接' });

    const name = [c.case_number, c.title, c.client_name].filter(Boolean).join(' ');
    const f = await gdrive.createCaseFolder(name);
    db.prepare('UPDATE cases SET drive_folder_id = ?, drive_folder_url = ? WHERE id = ?').run(f.id, f.webViewLink, c.id);
    res.json({ url: f.webViewLink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
