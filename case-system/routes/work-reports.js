const express = require('express');
const db = require('../db');
const gdrive = require('../lib/gdrive');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 把 JSON 的使用者 id 陣列 → 名字陣列
function namesFromIds(json) {
  if (!json) return [];
  let ids;
  try { ids = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const map = {}; rows.forEach(r => { map[r.id] = r.name; });
  return ids.map(id => map[id] || ('#' + id));
}

// GET /api/work-reports/crew  → 可指派施工人員清單（給回報表單點選，只回 id/name 不含機密）
router.get('/crew', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, name FROM users WHERE active=1 AND accept_dispatch=1 ORDER BY sort_order, name`).all();
  res.json(rows);
});

// GET /api/work-reports/all?from=&to=  → 全部師傅回報（老闆/辦公室監控用；技術/施工看不到）
router.get('/all', requireAuth, (req, res) => {
  const me = req.session.user;
  // 完工回報總覽：老闆 + 被授權者(客服/社群/小組長等，由後台勾選 page_work_reports)
  if (me.role !== 'owner' && !(me.permissions && me.permissions.page_work_reports)) {
    return res.status(403).json({ error: '無權限' });
  }
  const { from, to } = req.query;
  let where = 'WHERE 1=1'; const p = [];
  if (from) { where += ' AND w.report_date >= ?'; p.push(from); }
  if (to)   { where += ' AND w.report_date <= ?'; p.push(to); }
  const rows = db.prepare(`
    SELECT w.*, u.name AS reporter_name, c.case_number, c.title AS case_title, cl.name AS client_name
    FROM work_reports w
    LEFT JOIN users u    ON u.id  = w.reporter_id
    LEFT JOIN cases c    ON c.id  = w.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${where}
    ORDER BY w.submitted_at DESC, w.id DESC
    LIMIT 500
  `).all(...p);
  res.json(rows.map(r => ({
    ...r,
    driver_names:       namesFromIds(r.driver_ids),
    prepper_names:      namesFromIds(r.prepper_ids),
    photographer_names: namesFromIds(r.photographer_ids),
  })));
});

// GET /api/work-reports/mine?dispatch_id=  → 帶入表單（我對這場的回報）
router.get('/mine', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { dispatch_id } = req.query;
  if (!dispatch_id) return res.json(null);
  const r = db.prepare(`SELECT * FROM work_reports WHERE dispatch_id=? AND reporter_id=?`).get(dispatch_id, uid);
  res.json(r || null);
});

// GET /api/work-reports?case_id=  → 該案件所有回報（辦公室看）
router.get('/', requireAuth, (req, res) => {
  const { case_id } = req.query;
  if (!case_id) return res.status(400).json({ error: '缺 case_id' });
  const rows = db.prepare(`
    SELECT w.*, u.name AS reporter_name
    FROM work_reports w
    LEFT JOIN users u ON u.id = w.reporter_id
    WHERE w.case_id = ?
    ORDER BY w.submitted_at DESC, w.id DESC
  `).all(case_id);
  res.json(rows.map(r => ({
    ...r,
    driver_names:       namesFromIds(r.driver_ids),
    prepper_names:      namesFromIds(r.prepper_ids),
    photographer_names: namesFromIds(r.photographer_ids),
  })));
});

// POST /api/work-reports  → 送出/更新回報（同一場 dispatch + 同一人 覆蓋）
router.post('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const b = req.body || {};
  if (!b.dispatch_id) return res.status(400).json({ error: '缺 dispatch_id' });
  const J = v => Array.isArray(v) ? JSON.stringify(v) : (v || null);
  try {
    db.prepare(`
      INSERT INTO work_reports
        (case_id, dispatch_id, report_date, reporter_id, driver_ids, prepper_ids, photographer_ids, photos_uploaded, progress_pct, notes, status, submitted_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(dispatch_id, reporter_id) DO UPDATE SET
        case_id=excluded.case_id, report_date=excluded.report_date,
        driver_ids=excluded.driver_ids, prepper_ids=excluded.prepper_ids, photographer_ids=excluded.photographer_ids,
        photos_uploaded=excluded.photos_uploaded, progress_pct=excluded.progress_pct, notes=excluded.notes,
        status='submitted', submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    `).run(
      b.case_id || null, b.dispatch_id, b.report_date || null, uid,
      J(b.driver_ids), J(b.prepper_ids), J(b.photographer_ids),
      b.photos_uploaded ? 1 : 0,
      (b.progress_pct != null && b.progress_pct !== '') ? Number(b.progress_pct) : null,
      b.notes || null
    );
    gdrive.safeEnsureDispatchSubfolder(Number(b.dispatch_id)); // 拍照者確定後→施工夾自動改名帶上拍照者
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
