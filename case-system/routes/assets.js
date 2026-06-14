const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushMessage } = require('./webhook');

function canManage(user) {
  return user.role === 'owner' || !!user.can_manage_assets;
}

function notifyManagers(orgId, msg) {
  // 通知同分店的倉管 + owner
  const targets = db.prepare(`
    SELECT line_user_id FROM users
    WHERE active=1 AND line_user_id IS NOT NULL
      AND (role='owner' OR can_manage_assets=1)
      AND (role='owner' OR org_id=?)
  `).all(orgId);
  targets.forEach(u => pushMessage(u.line_user_id, msg).catch(() => {}));
}

// ── 資產品項（倉管/老闆管理）────────────────────────────────────

router.get('/items', requireAuth, (req, res) => {
  const me = req.session.user;
  let sql = `SELECT a.*, o.name as org_name FROM assets a LEFT JOIN orgs o ON o.id=a.org_id WHERE a.active=1`;
  const params = [];
  if (me.role !== 'owner') {
    sql += ` AND a.org_id=?`; params.push(me.org_id);
  }
  sql += ` ORDER BY a.org_id, a.category, a.name`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/items', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const { name, category, is_consumable, quantity, unit, notes, location, org_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填入品項名稱' });
  const targetOrg = me.role === 'owner' ? (org_id || me.org_id) : me.org_id;
  const r = db.prepare(`INSERT INTO assets (org_id,name,category,is_consumable,quantity,unit,notes,location) VALUES (?,?,?,?,?,?,?,?)`)
    .run(targetOrg, name.trim(), category||null, is_consumable?1:0, quantity||0, unit||'個', notes||null, location||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/items/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const { name, category, is_consumable, quantity, unit, notes, location, active } = req.body;
  db.prepare(`UPDATE assets SET name=?,category=?,is_consumable=?,quantity=?,unit=?,notes=?,location=?,active=? WHERE id=?`)
    .run(name, category||null, is_consumable?1:0, quantity||0, unit||'個', notes||null, location||null, active??1, req.params.id);
  res.json({ ok: true });
});

router.delete('/items/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  db.prepare(`UPDATE assets SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 申請單 ────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, mine } = req.query;
  let sql = `
    SELECT r.*, u.name as user_name, a.name as asset_name, a.unit, a.is_consumable,
           o.name as org_name, ap.name as approved_by_name, rb.name as returned_by_name
    FROM asset_requests r
    LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN assets a ON a.id=r.asset_id
    LEFT JOIN orgs o ON o.id=r.org_id
    LEFT JOIN users ap ON ap.id=r.approved_by
    LEFT JOIN users rb ON rb.id=r.returned_by
    WHERE 1=1
  `;
  const params = [];
  if (mine === '1' || (!canManage(me) && me.role !== 'owner')) {
    sql += ` AND r.user_id=?`; params.push(me.id);
  } else if (me.role !== 'owner') {
    sql += ` AND r.org_id=?`; params.push(me.org_id);
  }
  if (status) { sql += ` AND r.status=?`; params.push(status); }
  sql += ` ORDER BY r.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { asset_id, quantity, purpose, due_date } = req.body;
  if (!asset_id) return res.status(400).json({ error: '請選擇品項' });
  const asset = db.prepare(`SELECT * FROM assets WHERE id=? AND active=1`).get(asset_id);
  if (!asset) return res.status(404).json({ error: '品項不存在' });
  const r = db.prepare(`
    INSERT INTO asset_requests (user_id,org_id,asset_id,quantity,purpose,due_date,status)
    VALUES (?,?,?,?,?,?,?)
  `).run(me.id, me.org_id||asset.org_id, asset_id, quantity||1, purpose||null, due_date||null, 'pending');

  notifyManagers(me.org_id||asset.org_id,
    `【資產申請通知】\n${me.name} 申請「${asset.name}」×${quantity||1}\n說明：${purpose||'無'}\n請至系統審核`);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 審核：核准
router.patch('/:id/approve', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM asset_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: '此申請無法審核' });
  const { due_date, notes } = req.body;
  db.prepare(`UPDATE asset_requests SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,due_date=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, due_date||null, notes||null, r.id);
  const asset = db.prepare(`SELECT name FROM assets WHERE id=?`).get(r.asset_id);
  const applicant = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(r.user_id);
  if (applicant?.line_user_id) {
    pushMessage(applicant.line_user_id,
      `【資產申請核准】\n您申請的「${asset?.name}」已核准${due_date ? '\n請於 '+due_date+' 前歸還' : ''}`
    ).catch(()=>{});
  }
  res.json({ ok: true });
});

// 審核：拒絕
router.patch('/:id/reject', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM asset_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: '此申請無法拒絕' });
  const reason = req.body.reason || '';
  db.prepare(`UPDATE asset_requests SET status='rejected',approved_by=?,approved_at=CURRENT_TIMESTAMP,reject_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, reason, r.id);
  const asset = db.prepare(`SELECT name FROM assets WHERE id=?`).get(r.asset_id);
  const applicant = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(r.user_id);
  if (applicant?.line_user_id) {
    pushMessage(applicant.line_user_id,
      `【資產申請未核准】\n您申請的「${asset?.name}」未核准\n原因：${reason||'未填寫'}`
    ).catch(()=>{});
  }
  res.json({ ok: true });
});

// 標記歸還
router.patch('/:id/return', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM asset_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'approved') return res.status(400).json({ error: '此申請無法標記歸還' });
  db.prepare(`UPDATE asset_requests SET status='returned',returned_by=?,returned_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, r.id);
  res.json({ ok: true });
});

// ── 逾期通知（由 server.js 定期呼叫）────────────────────────────
router.post('/check-overdue', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const overdue = db.prepare(`
    SELECT r.*, u.name as user_name, a.name as asset_name, o.name as org_name
    FROM asset_requests r
    LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN assets a ON a.id=r.asset_id
    LEFT JOIN orgs o ON o.id=r.org_id
    WHERE r.status='approved' AND r.due_date IS NOT NULL AND r.due_date < ? AND r.is_consumable=0
  `).all(today);

  overdue.forEach(r => {
    notifyManagers(r.org_id,
      `【借用逾期提醒】\n${r.user_name} 借用的「${r.asset_name}」已逾期未還\n應還日期：${r.due_date}`);
  });
  res.json({ ok: true, count: overdue.length });
});

module.exports = router;
