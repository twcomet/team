const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner, requireCalendarAccess } = require('../middleware/auth');
const gdrive = require('../lib/gdrive');
const gcal = require('../lib/gcal');
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

// ── 派單行事曆同步（只有老闆）──────────────────────────────
// 狀態
router.get('/gcal/status', requireAuth, requireOwner, (req, res) => {
  res.json(gcal.calendarInfo());
});

// 開/關同步
router.post('/gcal/toggle', requireAuth, requireOwner, (req, res) => {
  gcal.setEnabled(!!req.body.enabled);
  res.json({ ok: true, enabled: gcal.syncEnabled() });
});

// 回填：啟動背景同步（立即回傳，前端輪詢 /gcal/sync-status 看進度）。客服(有行事曆頁權限)也可用
router.post('/gcal/sync-all', requireAuth, requireCalendarAccess, (req, res) => {
  try { res.json(gcal.startSync('sync')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 清除重建：啟動背景「刪光→重建」任務（修正重複/孤兒事件）
router.post('/gcal/rebuild', requireAuth, requireOwner, (req, res) => {
  try { res.json(gcal.startSync('rebuild')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 同步進度查詢（前端每 2 秒輪詢）。客服(有行事曆頁權限)也可用
router.get('/gcal/sync-status', requireAuth, requireCalendarAccess, (req, res) => {
  res.json(gcal.syncJobStatus());
});

// 診斷：查有幾個「繪新派單」行事曆、各幾筆事件、系統用哪個（直接開網址看 JSON）
router.get('/gcal/diagnose', requireAuth, requireOwner, async (req, res) => {
  try { res.json(await gcal.diagnose()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 把「繪新派單」行事曆分享給指定信箱（讓它出現在對方 Google 行事曆清單）
router.post('/gcal/share', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await gcal.shareCalendar(req.body.email, req.body.role);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// 批次補建：為所有還沒有雲端資料夾的舊案件建立（老闆手動觸發）
router.post('/backfill-folders', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await gdrive.backfillCaseFolders();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
