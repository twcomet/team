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
  const RESTRICTED_ROLES = ['contractor_install','contractor_sales','dealer'];
  const isContractor = RESTRICTED_ROLES.includes(user.role);
  const perms = user.permissions ? JSON.parse(user.permissions) : {};

  // 從 role_defaults 資料表讀取管理員在後台設定的角色預設
  const rdRow = db.prepare(`SELECT default_perms FROM role_defaults WHERE role_value = ?`).get(user.role);
  const roleDefaults = rdRow ? JSON.parse(rdRow.default_perms || '{}') : null;

  // 優先順序：個人覆蓋 > 角色預設(DB) > 硬編碼 fallback > !isContractor
  const perm = (key, fallback) => {
    if (isOwner) return true;
    if (perms[key] !== undefined) return !!perms[key];
    if (roleDefaults !== null && roleDefaults[key] !== undefined) return !!roleDefaults[key];
    if (fallback !== undefined) return fallback;
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
    can_delete: !!user.can_delete,
    is_manager: !!user.is_manager,
    view_all_branches: def.viewAllBranches,
    allowed_org_ids: user.allowed_org_ids ? JSON.parse(user.allowed_org_ids) : [],
    manage_users: def.manageUsers,
    manage_orgs: def.manageOrgs,
    permissions: {
      page_dashboard:      perm('page_dashboard',   user.role === 'hq_accounting'),
      page_cases:          perm('page_cases'),
      page_line_inquiries: perm('page_line_inquiries'),
      page_clients:        perm('page_clients'),
      page_calendar:       perm('page_calendar'),
      page_payments:       perm('page_payments'),
      page_ledger:         perm('page_ledger',      user.role === 'hq_accounting'),
      page_dispatch_pool:  perm('page_dispatch_pool', def.manageUsers),
      page_cases_deal:     perm('page_cases_deal',  ['vp','hq_cs','hq_sales','hq_accounting','hq_hr'].includes(user.role)),
      page_materials:      perm('page_materials',   def.manageUsers),
      page_material_calc:  perm('page_material_calc', true),
      page_performance:    perm('page_performance', def.manageUsers),
      page_reports:        perm('page_reports',     def.manageUsers),
      page_marketing:      perm('page_marketing',   def.manageUsers),
      page_admin:          def.manageUsers,
      my_tasks:            perm('my_tasks',          isContractor),
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
