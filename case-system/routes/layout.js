const express = require('express');
const db      = require('../db');
const { requireAuth, isOutsourced } = require('../middleware/auth');
const router  = express.Router();

// 排版工具存取權：owner / 管理者 / 被授予 can_layout 者（可開給學員、經銷商）
function canLayout(req, res, next) {
  const u = req.session.user;
  if (u.role === 'owner' || !!u.manage_users || !!u.is_manager || !!u.can_layout) return next();
  res.status(403).json({ error: '無排版工具權限' });
}

// GET / — 專案清單（依組織）。外包/經銷只看自己建立的
router.get('/projects', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid, role } = req.session.user;
  const archived = req.query.archived === '1' ? 1 : 0;
  const ownOnly = isOutsourced(role);
  const rows = db.prepare(`
    SELECT p.id, p.name, p.archived, p.created_at, p.updated_at, u.name AS created_by_name
    FROM layout_projects p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.org_id = ? AND p.archived = ?${ownOnly ? ' AND p.created_by = ?' : ''}
    ORDER BY p.updated_at DESC
  `).all(...(ownOnly ? [org_id, archived, uid] : [org_id, archived]));
  res.json(rows);
});

// GET /projects/:id — 單一專案（含 data）
router.get('/projects/:id', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid, role } = req.session.user;
  const p = db.prepare(`SELECT * FROM layout_projects WHERE id=? AND org_id=?`).get(req.params.id, org_id);
  if (!p) return res.status(404).json({ error: '找不到專案' });
  // 外包/經銷只能開自己建立的
  if (isOutsourced(role) && p.created_by !== uid) return res.status(404).json({ error: '找不到專案' });
  try { p.data = JSON.parse(p.data || '{}'); } catch { p.data = {}; }
  res.json(p);
});

// POST /projects — 新增
router.post('/projects', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid } = req.session.user;
  const { name, data } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請輸入專案名稱' });
  const r = db.prepare(`INSERT INTO layout_projects (org_id, name, data, created_by) VALUES (?,?,?,?)`)
    .run(org_id, name.trim(), JSON.stringify(data || {}), uid);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// PUT /projects/:id — 更新（名稱 / data）
router.put('/projects/:id', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid, role } = req.session.user;
  const p = db.prepare(`SELECT id, created_by FROM layout_projects WHERE id=? AND org_id=?`).get(req.params.id, org_id);
  if (!p) return res.status(404).json({ error: '找不到專案' });
  if (isOutsourced(role) && p.created_by !== uid) return res.status(403).json({ error: '只能編輯自己建立的排版專案' });
  const { name, data } = req.body;
  db.prepare(`UPDATE layout_projects SET name=COALESCE(?,name), data=COALESCE(?,data), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name?.trim() || null, data !== undefined ? JSON.stringify(data) : null, req.params.id);
  res.json({ ok: true });
});

// PATCH /projects/:id/archive — 歸檔 / 取消歸檔
router.patch('/projects/:id/archive', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid, role } = req.session.user;
  if (isOutsourced(role)) {
    const p = db.prepare(`SELECT created_by FROM layout_projects WHERE id=? AND org_id=?`).get(req.params.id, org_id);
    if (!p) return res.status(404).json({ error: '找不到專案' });
    if (p.created_by !== uid) return res.status(403).json({ error: '只能操作自己建立的排版專案' });
  }
  const archived = req.body.archived ? 1 : 0;
  db.prepare(`UPDATE layout_projects SET archived=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?`)
    .run(archived, req.params.id, org_id);
  res.json({ ok: true });
});

// DELETE /projects/:id — 僅建立者本人，或老闆/管理者可刪
router.delete('/projects/:id', requireAuth, canLayout, (req, res) => {
  const { org_id, id: uid, role, manage_users, is_manager } = req.session.user;
  const p = db.prepare(`SELECT created_by FROM layout_projects WHERE id=? AND org_id=?`).get(req.params.id, org_id);
  if (!p) return res.status(404).json({ error: '找不到專案' });
  const isManager = role === 'owner' || !!manage_users || !!is_manager;
  if (!isManager && p.created_by !== uid) {
    return res.status(403).json({ error: '只能刪除自己建立的排版專案' });
  }
  db.prepare(`DELETE FROM layout_projects WHERE id=? AND org_id=?`).run(req.params.id, org_id);
  res.json({ ok: true });
});

module.exports = router;
