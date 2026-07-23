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
  // 🔒 機密鐵律：技術/施工/經銷角色絕不可看業績/財務（總覽/業績/財務），強制關閉不論後台如何設定
  const noBiz = ['hq_tech','branch_tech','contractor_install','contractor_sales','dealer'].includes(user.role);
  const perms = user.permissions ? JSON.parse(user.permissions) : {};

  // 從 role_defaults 資料表讀取管理員在後台設定的角色預設（內建角色）
  // 若找不到，則改查 custom_roles 表（自訂角色）
  const rdRow = db.prepare(`SELECT default_perms FROM role_defaults WHERE role_value = ?`).get(user.role);
  let roleDefaults = rdRow ? JSON.parse(rdRow.default_perms || '{}') : null;
  if (roleDefaults === null) {
    const crRow = db.prepare(`SELECT default_perms FROM custom_roles WHERE code=? AND active=1 LIMIT 1`).get(user.role);
    if (crRow) roleDefaults = JSON.parse(crRow.default_perms || '{}');
  }

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
    can_see_amounts:     !!user.can_see_amounts,
    can_see_cost:        !!user.can_see_cost,
    can_see_labor_cost:  !!user.can_see_labor_cost,
    can_manage_assets:   !!user.can_manage_assets,
    can_delete: !!user.can_delete,
    can_ship:   !!user.can_ship,
    can_layout: !!user.can_layout,
    is_manager: !!user.is_manager,
    view_all_branches: def.viewAllBranches,
    allowed_org_ids: user.allowed_org_ids ? JSON.parse(user.allowed_org_ids) : [],
    manage_users: def.manageUsers,
    manage_orgs: def.manageOrgs,
    permissions: {
      page_dashboard:      !noBiz && perm('page_dashboard',   user.role === 'hq_accounting'),
      page_cases:          perm('page_cases'),
      page_line_inquiries: perm('page_line_inquiries'),
      page_care_logs:      perm('page_care_logs', ['vp','hq_cs','hq_cs_manager','hq_sales'].includes(user.role)),
      page_clients:        perm('page_clients'),
      page_calendar:       perm('page_calendar'),
      page_payments:       perm('page_payments'),
      page_ledger:         perm('page_ledger',      user.role === 'hq_accounting'),
      page_expenses:       perm('page_expenses',    user.role === 'hq_accounting'),
      page_subcontract:    perm('page_subcontract', ['owner','branch_manager','hq_accounting','hq_cs'].includes(user.role)),
      page_dispatch_pool:  perm('page_dispatch_pool', def.manageUsers),
      page_cases_deal:     perm('page_cases_deal',  ['vp','hq_cs','hq_sales','hq_accounting','hq_hr'].includes(user.role)),
      page_materials:      perm('page_materials',   def.manageUsers),
      page_material_calc:  perm('page_material_calc', true),
      page_performance:    !noBiz && perm('page_performance', def.manageUsers),
      page_reports:        !noBiz && perm('page_reports',     def.manageUsers),
      page_marketing:      perm('page_marketing',   def.manageUsers),
      page_work_reports:   perm('page_work_reports', false),
      page_template_settings: perm('page_template_settings', ['hq_cs_manager','hq_cs'].includes(user.role)),
      page_admin:          def.manageUsers,
      my_tasks:            perm('my_tasks',          isContractor),
    },
  };

  db.prepare(`INSERT INTO audit_logs (user_id, action, detail) VALUES (?, 'login', ?)`)
    .run(user.id, `登入：${req.ip}`);

  // 記錄登入 session（供員工活動報告使用）
  const loginSession = db.prepare(`INSERT INTO login_sessions (user_id, ip) VALUES (?, ?)`)
    .run(user.id, req.ip || null);
  req.session.login_session_id = loginSession.lastInsertRowid;

  req.session.user.contract_signed_at = user.contract_signed_at || null;

  const isStudent = ['contractor_install','contractor_sales'].includes(user.role);
  const needsContract = !user.contract_signed_at;
  res.json({ ok: true, user: req.session.user, redirect: needsContract ? '/contract' : (isStudent ? '/marketplace' : null) });
});

router.post('/logout', (req, res) => {
  const uid = req.session.user?.id;
  const loginSessionId = req.session.login_session_id;
  req.session.destroy(() => {
    if (uid) {
      db.prepare(`INSERT INTO audit_logs (user_id, action) VALUES (?, 'logout')`).run(uid);
      if (loginSessionId) {
        db.prepare(`
          UPDATE login_sessions
          SET logout_at=CURRENT_TIMESTAMP,
              duration_seconds=CAST((julianday('now') - julianday(login_at)) * 86400 AS INTEGER)
          WHERE id=?
        `).run(loginSessionId);
      }
    }
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登入' });
  // 每次都從 DB 刷新可異動的權限欄位，讓管理員改完立即生效（不需重登）
  const fresh = db.prepare(`SELECT can_see_amounts, can_see_cost, can_see_labor_cost, can_manage_assets, can_delete, can_ship, can_layout, is_manager, permissions FROM users WHERE id=?`).get(req.session.user.id);
  if (fresh) {
    req.session.user.can_see_amounts    = !!fresh.can_see_amounts;
    req.session.user.can_see_cost       = !!fresh.can_see_cost;
    req.session.user.can_see_labor_cost = !!fresh.can_see_labor_cost;
    req.session.user.can_manage_assets  = !!fresh.can_manage_assets;
    req.session.user.can_delete         = !!fresh.can_delete;
    req.session.user.can_ship           = !!fresh.can_ship;
    req.session.user.can_layout         = !!fresh.can_layout;
    req.session.user.is_manager         = !!fresh.is_manager;
    // 同步個人權限覆蓋（permissions JSON）
    if (fresh.permissions) {
      try {
        const perms = JSON.parse(fresh.permissions);
        req.session.user.permissions = { ...(req.session.user.permissions || {}), ...perms };
      } catch {}
    }
  }
  res.json(req.session.user);
});

// GET /api/auth/debug-session（暫時診斷用）
router.get('/debug-session', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登入' });
  const dbUser = db.prepare(`SELECT id, name, role, can_manage_assets, active FROM users WHERE id=?`).get(req.session.user.id);
  res.json({
    session_role: req.session.user.role,
    session_can_manage_assets: req.session.user.can_manage_assets,
    db_role: dbUser?.role,
    db_can_manage_assets: dbUser?.can_manage_assets,
    db_active: dbUser?.active,
    user_id: req.session.user.id,
    user_name: req.session.user.name,
  });
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
