const express = require('express');
const db = require('../db');
const { requireAuth, isOutsourced } = require('../middleware/auth');
const gcal = require('../lib/gcal');
const router = express.Router();

// 暫定事項＝未關聯案件的行事曆備忘（洽談中/估價中先 memo）。
// 權限與「派單行事曆」一致：owner 或 page_calendar；外包夥伴不可。全公司/分店可見。
function canCalendar(me) { return me.role === 'owner' || (me.permissions && me.permissions.page_calendar); }
function guard(req, res) {
  const me = req.session.user;
  if (isOutsourced(me.role) || !canCalendar(me)) { res.status(403).json({ error: '無行事曆權限' }); return null; }
  return me;
}
function validate(b, res) {
  if (!b.title || !String(b.title).trim()) { res.status(400).json({ error: '請輸入標題' }); return false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date || ''))) { res.status(400).json({ error: '請選擇日期' }); return false; }
  return true;
}
const clean = v => { const s = (v == null ? '' : String(v)).trim(); return s || null; };

// 新增
router.post('/', requireAuth, (req, res) => {
  const me = guard(req, res); if (!me) return;
  if (!validate(req.body, res)) return;
  const { title, event_date, event_time, note } = req.body;
  const r = db.prepare(`INSERT INTO adhoc_events (title,event_date,event_time,note,org_id,created_by)
    VALUES (?,?,?,?,?,?)`).run(String(title).trim(), event_date, clean(event_time), clean(note), me.org_id || null, me.id);
  gcal.safeSyncAdhoc(r.lastInsertRowid);   // 同步到 Google 繪新派單（best-effort，不阻塞）
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 編輯
router.put('/:id', requireAuth, (req, res) => {
  const me = guard(req, res); if (!me) return;
  const id = parseInt(req.params.id);
  const cur = db.prepare('SELECT id FROM adhoc_events WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '找不到暫定事項' });
  if (!validate(req.body, res)) return;
  const { title, event_date, event_time, note } = req.body;
  db.prepare(`UPDATE adhoc_events SET title=?,event_date=?,event_time=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(String(title).trim(), event_date, clean(event_time), clean(note), id);
  gcal.safeSyncAdhoc(id);                   // 日期/內容變更 → 同步更新 Google 事件
  res.json({ ok: true });
});

// 刪除
router.delete('/:id', requireAuth, (req, res) => {
  const me = guard(req, res); if (!me) return;
  const id = parseInt(req.params.id);
  const cur = db.prepare('SELECT id, gcal_event_id FROM adhoc_events WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '找不到暫定事項' });
  if (cur.gcal_event_id) gcal.safeRemoveAdhoc(cur.gcal_event_id, id);   // 先移除 Google 事件
  db.prepare('DELETE FROM adhoc_events WHERE id=?').run(id);
  res.json({ ok: true });
});

module.exports = router;
