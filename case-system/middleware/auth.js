const db = require('../db');

// 角色定義：每個 role 的預設權限
const ROLE_DEFS = {
  owner:              { label:'最高管理者', viewAllBranches:true,  viewAmounts:true,  manageUsers:true,  manageOrgs:true  },
  vp:                 { label:'副總',       viewAllBranches:true,  viewAmounts:true,  manageUsers:true,  manageOrgs:false },
  hq_cs:              { label:'客服',       viewAllBranches:true,  viewAmounts:true,  manageUsers:false, manageOrgs:false },
  hq_cs_manager:     { label:'客服主管',   viewAllBranches:true,  viewAmounts:true,  manageUsers:false, manageOrgs:false },
  hq_sales:           { label:'業務',       viewAllBranches:true,  viewAmounts:true,  manageUsers:false, manageOrgs:false },
  hq_tech:            { label:'技術',       viewAllBranches:false, viewAmounts:false, manageUsers:false, manageOrgs:false },
  hq_accounting:      { label:'會計',       viewAllBranches:true,  viewAmounts:true,  manageUsers:false, manageOrgs:false },
  hq_hr:              { label:'人事',       viewAllBranches:true,  viewAmounts:false, manageUsers:true,  manageOrgs:false },
  branch_manager:     { label:'分店負責人', viewAllBranches:false, viewAmounts:true,  manageUsers:false, manageOrgs:false },
  branch_sales:       { label:'分店業務',   viewAllBranches:false, viewAmounts:true,  manageUsers:false, manageOrgs:false },
  branch_tech:        { label:'分店技術',   viewAllBranches:false, viewAmounts:false, manageUsers:false, manageOrgs:false },
  contractor_install: { label:'約聘技師',   viewAllBranches:false, viewAmounts:false, manageUsers:false, manageOrgs:false },
  contractor_sales:   { label:'約聘業務',   viewAllBranches:false, viewAmounts:false, manageUsers:false, manageOrgs:false },
  dealer:             { label:'經銷商',     viewAllBranches:false, viewAmounts:false, manageUsers:false, manageOrgs:false },
};

// 外包/經銷角色：不隸屬公司內部，僅能看/操作自己的工作，全公司視圖一律鎖住
const OUTSOURCED_ROLES = ['contractor_install', 'contractor_sales', 'dealer'];
function isOutsourced(role) { return OUTSOURCED_ROLES.includes(role); }

function getRoleDef(role) {
  if (ROLE_DEFS[role]) return ROLE_DEFS[role];
  try {
    const cr = db.prepare(`SELECT * FROM custom_roles WHERE code=? AND active=1 LIMIT 1`).get(role);
    if (cr) {
      const p = JSON.parse(cr.default_perms || '{}');
      return {
        label: cr.label,
        viewAllBranches: cr.view_all_branches === 1,
        viewAmounts: !!p.can_see_amounts,
        manageUsers: false,
        manageOrgs:  false,
      };
    }
  } catch (_) {}
  return ROLE_DEFS.hq_tech;
}

// ── Middleware ──────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '請先登入' });
    return res.redirect('/');
  }
  next();
}

function requireOwner(req, res, next) {
  if (req.session?.user?.role !== 'owner') {
    return res.status(403).json({ error: '僅最高管理者可操作' });
  }
  next();
}

// 允許最高管理者，或有「派單行事曆」頁權限的人（如客服）操作行事曆同步
function requireCalendarAccess(req, res, next) {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: '請先登入' });
  if (u.role === 'owner' || u.permissions?.page_calendar) return next();
  return res.status(403).json({ error: '無派單行事曆權限' });
}

function requireCanManageUsers(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: '請先登入' });
  const def = getRoleDef(user.role);
  if (!def.manageUsers) return res.status(403).json({ error: '權限不足' });
  next();
}

// 根據使用者角色加上 org 過濾條件（舊版，向後相容）
function orgFilter(user) {
  const def = getRoleDef(user.role);
  if (def.viewAllBranches) return {}; // 不限制
  return { org_id: user.org_id };     // 只看自己的分店
}

// 回傳 { sql, params } 可直接插入 WHERE 子句（支援多店別）
function orgFilterSQL(user, col) {
  if (user.view_all_branches) return { sql: '', params: [] };
  const extra = Array.isArray(user.allowed_org_ids) ? user.allowed_org_ids : [];
  const ids = [...new Set([user.org_id, ...extra].filter(Boolean))];
  if (ids.length === 0) return { sql: '', params: [] };
  if (ids.length === 1) return { sql: `${col} = ?`, params: [ids[0]] };
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

module.exports = { ROLE_DEFS, OUTSOURCED_ROLES, isOutsourced, getRoleDef, requireAuth, requireOwner, requireCalendarAccess, requireCanManageUsers, orgFilter, orgFilterSQL };
