const ROLE_LABELS = {
  owner:'最高管理者', hq_cs:'客服', hq_cs_manager:'客服主管', hq_sales:'業務（總部）',
  hq_tech:'技術（總部）', hq_accounting:'會計', hq_hr:'人事',
  branch_manager:'分店負責人', branch_sales:'分店業務',
  branch_tech:'分店技術', contractor_install:'約聘技師',
  contractor_sales:'約聘業務', dealer:'經銷商',
};
// 修改此處須同步 case-detail.html STAGES_BY_GROUP / STATUS_OPTIONS_BY_GROUP 及 cases.html CFG.stageNames
const STATUS_LABELS = {
  inquiry:           '詢價需初步估價',
  initial_estimate:  '已初步估價',
  survey_pending:    '待排場勘',
  survey_scheduled:  '已排場勘',
  surveyed:          '已場勘',
  quote_draft:       '已建報價資料',
  quoted:            '已發報價單',
  contracted:        '成交待派案',
  dispatched:        '已派案待施工',
  payment:           '完工請款',
  closed:            '結案保存',
  invalid:           '無效保存',
  tech_accepted:     '技師已接案',
};
const PAYMENT_LABELS = { unpaid:'未收款', partial:'部分收款', paid:'已收款', overdue:'逾期' };
const CASE_TYPE_LABELS = { home:'居家', commercial:'商空', elevator:'電梯', glass:'玻璃', extra:'外快', outsource:'外包', output:'輸出', other:'其他' };

function badge(text, cls) { return `<span class="badge badge-${cls}">${text}</span>`; }
function statusBadge(s) { return badge(STATUS_LABELS[s] || s, s); }
function paymentBadge(s) { return badge(PAYMENT_LABELS[s] || s, s); }
function fmt(n) { return (n != null && n !== '') ? `$${Math.round(Number(n)).toLocaleString()}` : '—'; }
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

  const p = currentUser.permissions || {};
  const mu = !!currentUser.manage_users;

  // 依權限隱藏側邊欄項目（所有頁面都在此管控）
  const pageMap = {
    dashboard:        p.page_dashboard,
    cases:            p.page_cases,
    'cases-inquiry':  p.page_cases,
    'cases-survey':   p.page_cases,
    'cases-deal':     p.page_cases_deal !== undefined ? p.page_cases_deal : ['owner','vp','hq_cs','hq_cs_manager','hq_sales','hq_tech','hq_accounting','hq_hr'].includes(currentUser.role),
    'case-detail':    p.page_cases,
    clients:          p.page_clients,
    calendar:         p.page_calendar,
    payments:         p.page_payments,
    ledger:           p.page_ledger !== undefined ? p.page_ledger : p.page_payments,
    'line-inquiries': p.page_line_inquiries !== undefined ? p.page_line_inquiries : p.page_cases,
    'dispatch-detail':p.page_cases,
    'my-tasks':       p.my_tasks,
    'my-calendar':    true,   // 所有人可見
    hr:               p.page_hr !== undefined ? p.page_hr : ['owner','hq_hr'].includes(currentUser.role),
    admin:            mu,
    reports:          p.page_reports      !== undefined ? p.page_reports      : mu,
    performance:      p.page_performance  !== undefined ? p.page_performance  : mu,
    materials:        p.page_materials    !== undefined ? p.page_materials    : mu,
    'material-calc':  p.page_material_calc !== undefined ? p.page_material_calc : mu,
    marketing:        p.page_marketing    !== undefined ? p.page_marketing    : mu,
    'dispatch-pool':  p.page_dispatch_pool !== undefined ? p.page_dispatch_pool : mu,
    marketplace:      true,   // 市集所有人可見
    guide:            true,   // 系統使用說明所有人可見
  };
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    const page = el.dataset.page;
    if (page in pageMap && !pageMap[page]) el.style.display = 'none';
  });

  if (!mu) {
    document.querySelectorAll('[data-need="manage_users"]').forEach(el => el.style.display = 'none');
  }
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

  // ── 手機版漢堡選單 ──────────────────────────────────────
  const topBar  = document.querySelector('.top-bar');
  const sidebar = document.querySelector('.sidebar');
  if (topBar && sidebar) {
    // 注入背景遮罩
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    // 注入漢堡按鈕（插在 top-bar 最前面）
    const btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', '選單');
    btn.innerHTML = '<span></span><span></span><span></span>';
    topBar.insertBefore(btn, topBar.firstChild);

    const openSidebar  = () => { sidebar.classList.add('open');  backdrop.classList.add('open'); };
    const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); };

    btn.addEventListener('click', () =>
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar()
    );
    backdrop.addEventListener('click', closeSidebar);

    // 點選選單項目後自動收合（手機）
    sidebar.querySelectorAll('.nav-item').forEach(el =>
      el.addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar(); })
    );

    // ── 通知鈴鐺 ────────────────────────────────────────────
    const notifWrap = document.createElement('div');
    notifWrap.className = 'notif-wrap';
    notifWrap.innerHTML = `
      <button class="notif-bell" id="notifBell" aria-label="通知">
        🔔<span class="notif-badge" id="notifBadge" style="display:none">0</span>
      </button>
      <div class="notif-dropdown" id="notifDropdown" style="display:none">
        <div class="notif-header">
          <span>通知</span>
          <button class="notif-read-all" id="notifReadAll">全部已讀</button>
        </div>
        <div class="notif-list" id="notifList"></div>
      </div>`;
    topBar.appendChild(notifWrap);

    let notifOpen = false;
    document.getElementById('notifBell').addEventListener('click', e => {
      e.stopPropagation();
      notifOpen = !notifOpen;
      document.getElementById('notifDropdown').style.display = notifOpen ? '' : 'none';
      if (notifOpen) loadNotifications();
    });
    document.addEventListener('click', () => {
      if (notifOpen) { notifOpen = false; document.getElementById('notifDropdown').style.display = 'none'; }
    });
    document.getElementById('notifDropdown').addEventListener('click', e => e.stopPropagation());

    document.getElementById('notifReadAll').addEventListener('click', async () => {
      await fetch('/api/notifications/read-all', { method: 'PUT' });
      loadNotifications();
    });
  }

  async function loadNotifications() {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const { notifications, unread } = await res.json();
    const badge = document.getElementById('notifBadge');
    if (badge) { badge.textContent = unread; badge.style.display = unread > 0 ? '' : 'none'; }
    const list = document.getElementById('notifList');
    if (!list) return;
    if (!notifications.length) { list.innerHTML = '<div class="notif-empty">暫無通知</div>'; return; }
    list.innerHTML = notifications.map(n => `
      <div class="notif-item${n.is_read ? '' : ' unread'}" onclick="location.href='${n.url || '#'}'">
        <div class="notif-title">${n.title}</div>
        <div class="notif-body">${(n.body||'').replace(/\n/g,'<br>')}</div>
        <div class="notif-time">${n.created_at?.slice(0,16).replace('T',' ')}</div>
      </div>`).join('');
  }

  // 定時刷新未讀數（每 60 秒）
  async function refreshNotifBadge() {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const { unread } = await res.json();
    const badge = document.getElementById('notifBadge');
    if (badge) { badge.textContent = unread; badge.style.display = unread > 0 ? '' : 'none'; }
  }
  setInterval(refreshNotifBadge, 60000);
  refreshNotifBadge();
});

// ── Toast 右上角提示 ────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(container);
  }
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ── 正中央大提示（重要操作如刪除成功）──────────────────────
function showCenterToast(msg, icon = '✅') {
  const wrap = document.createElement('div');
  wrap.className = 'center-toast-wrap';
  wrap.innerHTML = `<div class="center-toast"><div class="ct-icon">${icon}</div><div class="ct-msg">${msg}</div></div>`;
  document.body.appendChild(wrap);
  const box = wrap.querySelector('.center-toast');
  requestAnimationFrame(() => box.classList.add('show'));
  setTimeout(() => {
    box.classList.remove('show');
    setTimeout(() => wrap.remove(), 250);
  }, 2000);
}

async function fetchUsers() {
  const r = await fetch('/api/users'); return r.ok ? r.json() : [];
}
async function fetchDispatchUsers() {
  const r = await fetch('/api/users?dispatch=1'); return r.ok ? r.json() : [];
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
