const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// owner、hq_hr 或有 manage_users 權限的管理者才可發布/編輯/刪除
function requireManager(req, res, next) {
  const u = req.session.user;
  if (u.role === 'owner' || u.role === 'hq_hr' || !!u.manage_users || !!u.is_manager) return next();
  res.status(403).json({ error: '僅限管理者操作' });
}

function withPersons(row) {
  if (!row) return null;
  row.persons = db.prepare(`
    SELECT dp.id, dp.user_id, dp.acknowledged_at, dp.improvement, dp.created_at,
           u.name AS user_name, u.role AS user_role
    FROM deficiency_persons dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deficiency_id = ?
    ORDER BY dp.created_at
  `).all(row.id);
  return row;
}

// GET / — 列出所有缺失（manager 看全部；一般人只看有被點名的）
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, year, case_id } = req.query;
  const isManager = me.role === 'owner' || me.role === 'hq_hr' || !!me.manage_users || !!me.is_manager;

  let where = 'WHERE d.org_id=?';
  const params = [me.org_id];

  if (!isManager) {
    where += ` AND EXISTS (SELECT 1 FROM deficiency_persons dp WHERE dp.deficiency_id=d.id AND dp.user_id=?)`;
    params.push(me.id);
  }
  if (case_id) { where += ' AND d.case_id=?'; params.push(case_id); }
  if (status)  { where += ' AND d.status=?'; params.push(status); }
  if (year)    { where += ` AND strftime('%Y',d.created_at)=?`; params.push(year); }

  const rows = db.prepare(`
    SELECT d.*,
      c.case_number, c.title AS case_title,
      u.name AS created_by_name
    FROM deficiencies d
    LEFT JOIN cases c ON c.id = d.case_id
    LEFT JOIN users u ON u.id = d.created_by
    ${where}
    ORDER BY d.created_at DESC
  `).all(...params);

  rows.forEach(r => {
    r.persons = db.prepare(`
      SELECT dp.user_id, dp.acknowledged_at, u.name AS user_name
      FROM deficiency_persons dp JOIN users u ON u.id=dp.user_id
      WHERE dp.deficiency_id=?
    `).all(r.id);
  });
  res.json(rows);
});

// GET /years
router.get('/years', requireAuth, (req, res) => {
  const { org_id } = req.session.user;
  const years = db.prepare(`
    SELECT DISTINCT strftime('%Y',created_at) AS year
    FROM deficiencies WHERE org_id=?
    ORDER BY year DESC
  `).all(org_id).map(r => r.year);
  res.json(years);
});

// GET /my-pending — 我的未確認缺失（用於我的任務）
router.get('/my-pending', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const rows = db.prepare(`
    SELECT d.*, dp.id AS dp_id, dp.acknowledged_at,
           c.case_number, c.title AS case_title,
           u.name AS created_by_name
    FROM deficiency_persons dp
    JOIN deficiencies d ON d.id = dp.deficiency_id
    LEFT JOIN cases c ON c.id = d.case_id
    LEFT JOIN users u ON u.id = d.created_by
    WHERE dp.user_id=? AND dp.acknowledged_at IS NULL AND d.status != 'resolved'
    ORDER BY d.created_at DESC
  `).all(uid);
  res.json(rows);
});

// GET /:id
// GET /reasons?category=reward|penalty — 事由清單（手動新增過的）；須在 /:id 之前
router.get('/reasons', requireAuth, (req, res) => {
  const cat = req.query.category === 'reward' ? 'reward' : 'penalty';
  const rows = db.prepare(`SELECT label FROM rp_reasons WHERE category=? AND org_id=? ORDER BY label`)
    .all(cat, req.session.user.org_id).map(r => r.label);
  res.json(rows);
});

router.get('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const row = db.prepare(`
    SELECT d.*, c.case_number, c.title AS case_title, u.name AS created_by_name
    FROM deficiencies d
    LEFT JOIN cases c ON c.id=d.case_id
    LEFT JOIN users u ON u.id=d.created_by
    WHERE d.id=? AND d.org_id=?
  `).get(req.params.id, me.org_id);
  if (!row) return res.status(404).json({ error: '找不到缺失記錄' });
  const isManager = me.role === 'owner' || me.role === 'hq_hr' || !!me.manage_users || !!me.is_manager;
  const isMember  = db.prepare(`SELECT 1 FROM deficiency_persons WHERE deficiency_id=? AND user_id=?`).get(row.id, me.id);
  if (!isManager && !isMember) return res.status(403).json({ error: '無權限' });
  res.json(withPersons(row));
});

// POST / — 新增缺失
router.post('/', requireAuth, requireManager, (req, res) => {
  const { org_id, id: uid } = req.session.user;
  const { case_id, type, title, description, damage_amount, person_ids,
          category, level, points } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '請填寫事由' });
  if (!person_ids?.length) return res.status(400).json({ error: '請選擇至少一位相關人員' });
  const cat = category === 'reward' ? 'reward' : 'penalty';

  const r = db.prepare(`
    INSERT INTO deficiencies (case_id, type, title, description, damage_amount, org_id, created_by, category, level, points)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(case_id||null, type||'other', title.trim(), description||null,
         damage_amount||null, org_id, uid, cat, level||null, Number(points)||0);

  const defId = r.lastInsertRowid;

  // 自動記住事由（供下次下拉選用）
  try { db.prepare(`INSERT OR IGNORE INTO rp_reasons (category, label, org_id) VALUES (?,?,?)`).run(cat, title.trim(), org_id); } catch(_) {}

  // 建立人員記錄 + 送站內通知
  const caseInfo = case_id ? db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(case_id) : null;
  const caseLabel = caseInfo ? `【${caseInfo.case_number}】` : '';
  const isReward = cat === 'reward';
  const notifTitle = `${isReward ? '🏅 嘉獎通知' : '⚠️ 缺失通知'}${level ? `（${level}）` : ''}：${title.trim()}`;

  for (const userId of person_ids) {
    try {
      db.prepare(`INSERT OR IGNORE INTO deficiency_persons (deficiency_id, user_id) VALUES (?,?)`).run(defId, userId);
      db.prepare(`
        INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url)
        VALUES (?, ?, ?, 'deficiency', 'deficiencies', ?, '/deficiencies')
      `).run(userId, notifTitle,
             `${caseLabel}${description || '請至嘉獎缺失管理頁面查看詳情並確認閱讀。'}`,
             defId);
    } catch(e) { /* 忽略重複插入 */ }
  }

  res.json({ ok: true, id: defId });
});


// PUT /:id — 編輯
router.put('/:id', requireAuth, requireManager, (req, res) => {
  const { org_id } = req.session.user;
  const { case_id, type, title, description, damage_amount, status } = req.body;
  db.prepare(`
    UPDATE deficiencies SET case_id=?, type=?, title=?, description=?, damage_amount=?,
      status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=?
  `).run(case_id||null, type||'other', title||'', description||null,
         damage_amount||null, status||'pending', req.params.id, org_id);
  res.json({ ok: true });
});

// DELETE /:id
router.delete('/:id', requireAuth, requireManager, (req, res) => {
  const { org_id } = req.session.user;
  db.prepare(`DELETE FROM deficiencies WHERE id=? AND org_id=?`).run(req.params.id, org_id);
  res.json({ ok: true });
});

// POST /:id/resolve — 結案
router.post('/:id/resolve', requireAuth, requireManager, (req, res) => {
  const { org_id } = req.session.user;
  db.prepare(`UPDATE deficiencies SET status='resolved', resolved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?`)
    .run(req.params.id, org_id);
  res.json({ ok: true });
});

// POST /:id/acknowledge — 員工確認已閱讀
router.post('/:id/acknowledge', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const dp = db.prepare(`SELECT id FROM deficiency_persons WHERE deficiency_id=? AND user_id=?`).get(req.params.id, uid);
  if (!dp) return res.status(403).json({ error: '你不在此缺失的相關人員名單中' });
  db.prepare(`UPDATE deficiency_persons SET acknowledged_at=CURRENT_TIMESTAMP WHERE id=?`).run(dp.id);
  // 若所有人都已閱讀 → 自動轉為「改善中」
  const total   = db.prepare(`SELECT COUNT(*) n FROM deficiency_persons WHERE deficiency_id=?`).get(req.params.id).n;
  const ackDone = db.prepare(`SELECT COUNT(*) n FROM deficiency_persons WHERE deficiency_id=? AND acknowledged_at IS NOT NULL`).get(req.params.id).n;
  if (ackDone >= total) {
    db.prepare(`UPDATE deficiencies SET status='in_review', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(req.params.id);
  }
  res.json({ ok: true });
});

// PUT /:id/persons/:pid/improvement — 填寫改善說明
router.put('/:id/persons/:pid/improvement', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const dp  = db.prepare(`SELECT id, user_id FROM deficiency_persons WHERE id=? AND deficiency_id=?`).get(req.params.pid, req.params.id);
  if (!dp) return res.status(404).json({ error: '找不到記錄' });
  const isManager = ['owner','hq_hr'].includes(req.session.user.role);
  if (dp.user_id !== uid && !isManager) return res.status(403).json({ error: '無權限' });
  db.prepare(`UPDATE deficiency_persons SET improvement=? WHERE id=?`).run(req.body.improvement||null, dp.id);
  res.json({ ok: true });
});

module.exports = router;
