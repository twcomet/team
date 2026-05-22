const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { getRoleDef } = require('../middleware/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare(`
    SELECT u.*, o.name as org_name, o.type as org_type
    FROM users u LEFT JOIN orgs o ON u.org_id = o.id
    WHERE u.username = ? AND u.active = 1
  `).get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const def = getRoleDef(user.role);
  const isOwner = user.role === 'owner';
  const perms = user.permissions ? JSON.parse(user.permissions) : {};
  // owner 一律全開；其他人依 permissions 欄位，預設 true（向後相容）
  const perm = (key, def2 = true) => isOwner ? true : (perms[key] ?? def2);

  req.session.user = {
    id: user.id,
    name: user.name,
    role: user.role,
    role_label: def.label,
    org_id: user.org_id,
    org_name: user.org_name,
    org_type: user.org_type,
    can_see_amounts: !!user.can_see_amounts,
    is_manager: !!user.is_manager,
    view_all_branches: def.viewAllBranches,
    manage_users: def.manageUsers,
    manage_orgs: def.manageOrgs,
    permissions: {
      page_dashboard: perm('page_dashboard'),
      page_cases:     perm('page_cases'),
      page_clients:   perm('page_clients'),
      page_calendar:  perm('page_calendar'),
      page_payments:  perm('page_payments'),
      page_admin:     def.manageUsers,
      my_tasks:       perm('my_tasks', false),
    },
  };

  db.prepare(`INSERT INTO audit_logs (user_id, action, detail) VALUES (?, 'login', ?)`)
    .run(user.id, `登入：${req.ip}`);

  res.json({ ok: true, user: req.session.user });
});

router.post('/logout', (req, res) => {
  const uid = req.session.user?.id;
  req.session.destroy(() => {
    if (uid) db.prepare(`INSERT INTO audit_logs (user_id, action) VALUES (?, 'logout')`).run(uid);
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登入' });
  res.json(req.session.user);
});

module.exports = router;
