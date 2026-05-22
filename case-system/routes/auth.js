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
