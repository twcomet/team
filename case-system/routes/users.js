const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireAuth, requireCanManageUsers, ROLE_DEFS } = require('../middleware/auth');
const router = express.Router();

// 取得使用者清單（依權限過濾）
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  let query = `SELECT u.id, u.name, u.username, u.role, u.org_id, u.department, u.allowed_org_ids,
                      u.is_manager, u.can_see_amounts, u.service_areas, u.active,
                      u.permissions, u.sort_order, u.daily_cost, u.line_user_id, o.name as org_name
               FROM users u LEFT JOIN orgs o ON u.org_id = o.id`;
  const params = [];

  if (!me.view_all_branches) {
    query += ` WHERE u.org_id = ?`;
    params.push(me.org_id);
  }
  query += ` ORDER BY u.sort_order, o.type DESC, u.name`;
  res.json(db.prepare(query).all(...params));
});

// 使用者排序
router.post('/reorder', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必須為陣列' });
  const upd = db.prepare(`UPDATE users SET sort_order=? WHERE id=?`);
  ids.forEach((id, i) => upd.run(i, id));
  res.json({ ok: true });
});

// 新增使用者
router.post('/', requireCanManageUsers, (req, res) => {
  const me = req.session.user;
  const { name, username, password, role, org_id, department, is_manager,
          can_see_amounts, service_areas, allowed_org_ids } = req.body;

  // 非 owner 只能建立自己分店的人
  if (me.role !== 'owner' && org_id != me.org_id) {
    return res.status(403).json({ error: '只能在自己的分店新增人員' });
  }
  if (!name || !username || !password || !role) {
    return res.status(400).json({ error: '請填入必要欄位' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare(`
      INSERT INTO users (name, username, password, role, org_id, department,
                         is_manager, can_see_amounts, service_areas, allowed_org_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, username, hash, role,
           org_id || me.org_id,
           department || null,
           is_manager ? 1 : 0,
           can_see_amounts ? 1 : 0,
           JSON.stringify(service_areas || []),
           allowed_org_ids?.length ? JSON.stringify(allowed_org_ids) : null);

    db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?, 'create_user', 'users', ?, ?)`)
      .run(me.id, result.lastInsertRowid, `新增帳號：${username} (${role})`);

    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '帳號已存在' });
  }
});

// 修改使用者
router.put('/:id', requireCanManageUsers, (req, res) => {
  const me = req.session.user;
  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!target) return res.status(404).json({ error: '使用者不存在' });

  // 非 owner 不能改其他分店的人，也不能改 owner
  if (me.role !== 'owner') {
    if (target.org_id !== me.org_id) return res.status(403).json({ error: '權限不足' });
    if (target.role === 'owner') return res.status(403).json({ error: '無法修改最高管理者' });
  }

  const { name, role, department, is_manager, can_see_amounts, service_areas, active, permissions, daily_cost } = req.body;
  const newAllowed = 'allowed_org_ids' in req.body
    ? (req.body.allowed_org_ids?.length ? JSON.stringify(req.body.allowed_org_ids) : null)
    : target.allowed_org_ids;
  db.prepare(`UPDATE users SET name=?, role=?, department=?, is_manager=?, can_see_amounts=?, service_areas=?, active=?, permissions=?, daily_cost=?, allowed_org_ids=? WHERE id=?`)
    .run(name, role, department, is_manager ? 1 : 0, can_see_amounts ? 1 : 0,
         JSON.stringify(service_areas || []), active ?? 1,
         JSON.stringify(permissions || {}), daily_cost ?? null, newAllowed, req.params.id);
  // line_user_id 只在明確傳入時才更新（unbind 用）
  if ('line_user_id' in req.body) {
    db.prepare(`UPDATE users SET line_user_id=? WHERE id=?`).run(req.body.line_user_id || null, req.params.id);
  }

  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'update_user', 'users', req.params.id, `修改帳號：${target.username} → 角色:${role}`);

  res.json({ ok: true });
});

// 修改密碼（本人或 owner）
router.put('/:id/password', requireAuth, (req, res) => {
  const me = req.session.user;
  const { password } = req.body;
  if (me.id !== Number(req.params.id) && me.role !== 'owner') {
    return res.status(403).json({ error: '只能修改自己的密碼' });
  }
  if (!password || password.length < 6) return res.status(400).json({ error: '密碼至少 6 個字元' });
  db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// 角色清單（系統內建 + 自訂，供前端 select 使用）
router.get('/roles', requireAuth, (req, res) => {
  const builtin = Object.entries(ROLE_DEFS).map(([value, def]) => ({
    value, label: def.label, type: 'builtin', default_perms: null,
  }));
  const custom = db.prepare(`SELECT * FROM custom_roles WHERE active=1 ORDER BY sort_order, id`).all()
    .map(r => ({ value: r.code, label: r.label, type: 'custom', id: r.id, default_perms: r.default_perms }));
  res.json([...builtin, ...custom]);
});

// 操作紀錄（owner only）
router.get('/audit-logs', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可查看' });
  const { from, to, uid, entity, limit = 200 } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (from)   { where += ' AND l.created_at >= ?'; params.push(from); }
  if (to)     { where += ' AND l.created_at <= ?'; params.push(to + ' 23:59:59'); }
  if (uid)    { where += ' AND l.user_id = ?'; params.push(uid); }
  if (entity) { where += ' AND l.entity = ?'; params.push(entity); }
  const rows = db.prepare(`
    SELECT l.*, u.name as user_name, u.username
    FROM audit_logs l
    LEFT JOIN users u ON l.user_id = u.id
    ${where}
    ORDER BY l.id DESC LIMIT ?
  `).all(...params, Number(limit));
  res.json(rows);
});

// ── 自訂角色 CRUD（owner only）────────────────────────────────

router.get('/custom-roles', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  res.json(db.prepare(`SELECT * FROM custom_roles ORDER BY sort_order, id`).all());
});

router.post('/custom-roles', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  const { label, default_perms, view_all_branches } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: '請填入角色名稱' });
  const r = db.prepare(`INSERT INTO custom_roles (code, label, default_perms, view_all_branches, sort_order)
    VALUES ('_tmp', ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM custom_roles))`)
    .run(label.trim(), JSON.stringify(default_perms || {}), view_all_branches ? 1 : 0);
  db.prepare(`UPDATE custom_roles SET code=? WHERE id=?`).run(`cr_${r.lastInsertRowid}`, r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid, code: `cr_${r.lastInsertRowid}` });
});

router.put('/custom-roles/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  const { label, default_perms, view_all_branches, active } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: '請填入角色名稱' });
  db.prepare(`UPDATE custom_roles SET label=?, default_perms=?, view_all_branches=?, active=? WHERE id=?`)
    .run(label.trim(), JSON.stringify(default_perms || {}), view_all_branches ? 1 : 0, active ?? 1, req.params.id);
  res.json({ ok: true });
});

router.post('/custom-roles/reorder', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必須為陣列' });
  const upd = db.prepare(`UPDATE custom_roles SET sort_order=? WHERE id=?`);
  ids.forEach((id, i) => upd.run(i, id));
  res.json({ ok: true });
});

router.delete('/custom-roles/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可操作' });
  const cr = db.prepare(`SELECT code FROM custom_roles WHERE id=?`).get(req.params.id);
  if (!cr) return res.status(404).json({ error: '角色不存在' });
  const inUse = db.prepare(`SELECT id FROM users WHERE role=? LIMIT 1`).get(cr.code);
  if (inUse) return res.status(400).json({ error: '此角色仍有使用者，請先更改其角色' });
  db.prepare(`DELETE FROM custom_roles WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/users/role-defaults — 取得所有系統角色預設權限
router.get('/role-defaults', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const rows = db.prepare(`SELECT role_value, default_perms FROM role_defaults`).all();
  const map = {};
  rows.forEach(r => { map[r.role_value] = JSON.parse(r.default_perms || '{}'); });
  res.json(map);
});

// PUT /api/users/role-defaults/:roleValue — 儲存系統角色預設權限
router.put('/role-defaults/:roleValue', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { default_perms } = req.body;
  db.prepare(`INSERT INTO role_defaults (role_value, default_perms, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(role_value) DO UPDATE SET default_perms=excluded.default_perms, updated_at=CURRENT_TIMESTAMP`)
    .run(req.params.roleValue, JSON.stringify(default_perms || {}));
  res.json({ ok: true });
});

module.exports = router;
