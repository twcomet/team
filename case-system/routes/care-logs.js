const express = require('express');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const router = express.Router();

// 客服關懷記錄不設機密：所有人都看得到全部、也都能維護（不鎖權限）
const nfuOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

// GET /api/care-logs?q=&scope=mine|all
// 跨案件的客服關懷清單。scope=mine 只看自己（我的任務/LINE 詢問的個人提醒用）；
// scope=all 看全部（不鎖權限，人人可用；依分店過濾）
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const canAll = me.role === 'owner' || me.permissions?.page_care_logs === true;   // 有「客服關懷記錄」權限者可看全部
  const scope = (req.query.scope === 'all' && canAll) ? 'all' : 'mine';
  const q = String(req.query.q || '').trim();
  const where = [];
  const params = [];
  if (scope === 'mine') { where.push('(cl.cs_user_id = ? OR cl.created_by = ?)'); params.push(me.id, me.id); }
  else { const { sql, params: op } = orgFilterSQL(me, 'c.org_id'); if (sql) { where.push(sql); params.push(...op); } }
  if (q) {
    where.push('(c.case_number LIKE ? OR c.title LIKE ? OR cl2.name LIKE ? OR cl.memo LIKE ? OR u.name LIKE ?)');
    const like = `%${q}%`; params.push(like, like, like, like, like);
  }
  const rows = db.prepare(`
    SELECT cl.id, cl.case_id, cl.action, cl.memo, cl.next_follow_up, cl.created_at,
           cl.cs_user_id, u.name AS cs_name, cb.name AS created_by_name,
           c.case_number, c.title AS case_title, c.status AS case_status,
           cl2.name AS client_name
    FROM case_care_logs cl
    JOIN cases c ON c.id = cl.case_id
    LEFT JOIN clients cl2 ON cl2.id = c.client_id
    LEFT JOIN users u  ON u.id  = cl.cs_user_id
    LEFT JOIN users cb ON cb.id = cl.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY cl.created_at DESC
    LIMIT 400
  `).all(...params);
  res.json({ scope, canSeeAll: canAll, results: rows });
});

// POST /api/care-logs  { case_id, cs_user_id, action, memo, next_follow_up }  跨案件新增（同步進案件的關懷 Tab）
router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { case_id, cs_user_id, action, memo, next_follow_up } = req.body;
  if (!case_id) return res.status(400).json({ error: '請選擇或建立案件' });
  const c = db.prepare('SELECT id FROM cases WHERE id=?').get(case_id);
  if (!c) return res.status(404).json({ error: '找不到案件' });
  if (!String(memo || '').trim() && !action) return res.status(400).json({ error: '請至少填寫處理事項或備註' });
  const r = db.prepare(`INSERT INTO case_care_logs (case_id, cs_user_id, action, memo, next_follow_up, created_by) VALUES (?,?,?,?,?,?)`)
    .run(case_id, cs_user_id || me.id, action || 'other', String(memo || '').trim() || null, nfuOf(next_follow_up), me.id);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'care_log', 'cases', case_id, `客服關懷：${action || ''}`);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// PUT /api/care-logs/:logId  編輯（本人或管理者）
router.put('/:logId', requireAuth, (req, res) => {
  const me = req.session.user;
  const cur = db.prepare('SELECT cs_user_id, created_by FROM case_care_logs WHERE id=?').get(req.params.logId);
  if (!cur) return res.status(404).json({ error: '找不到紀錄' });
  const { cs_user_id, action, memo, next_follow_up } = req.body;
  db.prepare(`UPDATE case_care_logs SET cs_user_id=?, action=?, memo=?, next_follow_up=? WHERE id=?`)
    .run(cs_user_id || cur.cs_user_id, action || 'other', String(memo || '').trim() || null, nfuOf(next_follow_up), req.params.logId);
  res.json({ ok: true });
});

// DELETE /api/care-logs/:logId  刪除（不鎖權限）
router.delete('/:logId', requireAuth, (req, res) => {
  const cur = db.prepare('SELECT id FROM case_care_logs WHERE id=?').get(req.params.logId);
  if (!cur) return res.status(404).json({ error: '找不到紀錄' });
  db.prepare('DELETE FROM case_care_logs WHERE id=?').run(req.params.logId);
  res.json({ ok: true });
});

module.exports = router;
