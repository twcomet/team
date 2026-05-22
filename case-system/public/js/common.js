const ROLE_LABELS = {
  owner:'最高管理者', hq_cs:'客服', hq_sales:'業務（總部）',
  hq_tech:'技術（總部）', hq_accounting:'會計', hq_hr:'人事',
  branch_manager:'分店負責人', branch_sales:'分店業務',
  branch_tech:'分店技術', contractor_install:'約聘技師',
  contractor_sales:'約聘業務', dealer:'經銷商',
};
const STATUS_LABELS = {
  initial_estimate: '1.初步估價',
  survey:           '2.場勘',
  quoted:           '3.出報價單',
  contracted:       '4.成交派案',
  payment:          '5.完工請款',
  closed:           '6.結案保存',
  invalid:          '7.無效案件保存',
};
const PAYMENT_LABELS = { unpaid:'未收款', partial:'部分收款', paid:'已收款', overdue:'逾期' };
const CASE_TYPE_LABELS = { home:'居家', commercial:'商空', elevator:'電梯', glass:'玻璃', extra:'外快', outsource:'外包', output:'輸出', other:'其他' };

function badge(text, cls) { return `<span class="badge badge-${cls}">${text}</span>`; }
function statusBadge(s) { return badge(STATUS_LABELS[s] || s, s); }
function paymentBadge(s) { return badge(PAYMENT_LABELS[s] || s, s); }
function fmt(n) { return (n != null && n !== '') ? `$${Number(n).toLocaleString()}` : '—'; }
function fmtDate(d) { return d ? d.slice(0, 10) : '—'; }

let currentUser = null;

async function loadUser() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) { location.href = '/'; return null; }
  currentUser = await res.json();
  const nameEl = document.getElementById('sidebarUserName');
  const roleEl = document.getElementById('sidebarUserRole');
  const orgEl  = document.getElementById('sidebarOrgName');
  if (nameEl) nameEl.textContent = currentUser.name;
  if (roleEl) roleEl.textContent = currentUser.role_label;
  if (orgEl)  orgEl.textContent  = currentUser.org_name || '';

  // 只有有 manageUsers 權限的人才能看到人員管理
  if (!currentUser.manage_users) {
    document.querySelectorAll('[data-need="manage_users"]').forEach(el => el.style.display = 'none');
  }
  // 只有 owner 才能看分店管理
  if (currentUser.role !== 'owner') {
    document.querySelectorAll('[data-need="owner"]').forEach(el => el.style.display = 'none');
  }
  return currentUser;
}

function highlightNav(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });
});

async function fetchUsers() {
  const r = await fetch('/api/users'); return r.ok ? r.json() : [];
}
async function fetchClients() {
  const r = await fetch('/api/clients'); return r.ok ? r.json() : [];
}
async function fetchOrgs() {
  const r = await fetch('/api/orgs'); return r.ok ? r.json() : [];
}
async function fetchRoles() {
  const r = await fetch('/api/users/roles'); return r.ok ? r.json() : [];
}

function populateSelect(el, items, valueKey, labelKey, placeholder = '請選擇') {
  el.innerHTML = `<option value="">${placeholder}</option>`;
  items.forEach(item => {
    const o = document.createElement('option');
    o.value = item[valueKey]; o.textContent = item[labelKey];
    el.appendChild(o);
  });
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;z-index:9999;
    background:${type === 'success' ? '#057a55' : '#e02424'};color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
