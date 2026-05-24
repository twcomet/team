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
  // 約聘/學員/經銷商：預設拒絕（whitelist）；內部員工：預設允許（blacklist）
  const RESTRICTED_ROLES = ['contractor_install','contractor_sales','dealer'];
  const isContractor = RESTRICTED_ROLES.includes(user.role);
  const perms = user.permissions ? JSON.parse(user.permissions) : {};
  // explicit = 明確指定的預設（覆蓋 role 預設）; 未指定則 contractor=false, 內部=true
  const perm = (key, explicit) => {
    if (isOwner) return true;
    if (perms[key] !== undefined) return !!perms[key];
    if (explicit !== undefined) return explicit;
    return !isContractor;
  };

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
      page_dashboard:      perm('page_dashboard'),
      page_cases:          perm('page_cases'),
      page_line_inquiries: perm('page_line_inquiries'),
      page_clients:        perm('page_clients'),
      page_calendar:       perm('page_calendar'),
      page_payments:       perm('page_payments'),
      page_ledger:         perm('page_ledger'),
      page_dispatch_pool:  perm('page_dispatch_pool', def.manageUsers), // 預設與 manage_users 一致
      page_admin:          def.manageUsers,
      my_tasks:            perm('my_tasks', isContractor), // 約聘預設開啟我的任務
    },
  };

  db.prepare(`INSERT INTO audit_logs (user_id, action, detail) VALUES (?, 'login', ?)`)
    .run(user.id, `登入：${req.ip}`);

  req.session.user.contract_signed_at = user.contract_signed_at || null;

  const isStudent = ['contractor_install','contractor_sales'].includes(user.role);
  const needsContract = !user.contract_signed_at;
  res.json({ ok: true, user: req.session.user, redirect: needsContract ? '/contract' : (isStudent ? '/marketplace' : null) });
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

// POST /api/auth/sign-contract
router.post('/sign-contract', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: '請先登入' });
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: 'missing signature' });

  const INTERNAL = ['owner','vp','hq_cs','hq_sales','hq_tech','hq_accounting','hq_hr','branch_manager','branch_sales','branch_tech'];
  const contractType = INTERNAL.includes(req.session.user.role) ? 'employee' : 'contractor';
  const now = new Date().toISOString().slice(0,10);

  db.prepare(`UPDATE users SET contract_signed_at=?, contract_type=?, contract_signature=? WHERE id=?`)
    .run(now, contractType, signature, req.session.user.id);
  req.session.user.contract_signed_at = now;

  db.prepare(`INSERT INTO audit_logs (user_id, action, detail) VALUES (?, 'contract_signed', ?)`)
    .run(req.session.user.id, `合約類型：${contractType}，簽署日期：${now}`);

  res.json({ ok: true, contract_type: contractType });
});

module.exports = router;
