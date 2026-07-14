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
  quote_needed:      '需出估價單',
  quote_sent:        '已出估價單',
  survey_pending:    '待排場勘',
  survey_scheduled:  '已排場勘',
  surveyed:          '已場勘',
  quote_draft:       '已建報價資料',
  quoted:            '已發報價單',
  contracted:        '成交待派工',
  dispatched:        '已派工待施工',
  constructing:      '施工中',
  payment:           '完工請款',
  closed:            '結案保存',
  invalid:           '無效保存',
  tech_accepted:     '技師已接案',
  aftersales:        '售後服務',
};
const PAYMENT_LABELS = { unpaid:'未收款', partial:'部分收款', paid:'已收款', overdue:'逾期' };
const CASE_TYPE_LABELS = { home:'居家', commercial:'商空', elevator:'電梯', glass:'玻璃', extra:'外快', outsource:'外包', output:'輸出', material_sale:'賣膜料', other:'其他' };

function badge(text, cls) { return `<span class="badge badge-${cls}">${text}</span>`; }
function statusBadge(s) { return badge(STATUS_LABELS[s] || s, s); }
function paymentBadge(s) { return badge(PAYMENT_LABELS[s] || s, s); }
function fmt(n) { return (n != null && n !== '') ? `$${Math.round(Number(n)).toLocaleString()}` : '—'; }
// 由 YYYY-MM-DD（或含時間的字串）取得（週幾），空值/壞日期回傳空字串，不會出現（NaN）
function weekdayZh(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(dt.getTime())) return '';
  return '（' + ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()] + '）';
}
function fmtDate(d) { return d ? d.slice(0, 10) + weekdayZh(d) : '—'; }

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
  // 外包/經銷角色：全公司視圖（派單行事曆、AI 顧問）一律隱藏，只留自己的工作
  const outsourced = ['contractor_install','contractor_sales','dealer'].includes(currentUser.role);

  // 依權限隱藏側邊欄項目（所有頁面都在此管控）
  const pageMap = {
    dashboard:        p.page_dashboard,
    cases:            p.page_cases,
    'cases-inquiry':  p.page_cases,
    'cases-survey':   p.page_cases,
    'cases-deal':     p.page_cases_deal !== undefined ? p.page_cases_deal : ['owner','vp','hq_cs','hq_cs_manager','hq_sales','hq_tech','hq_accounting','hq_hr'].includes(currentUser.role),
    'case-detail':    p.page_cases,
    'quote-list':     p.page_cases,
    estimator:         !['hq_tech','branch_tech','contractor_install','contractor_sales'].includes(currentUser.role),  // 技術/施工/外包不需估價
    'estimator-quotes':!['hq_tech','branch_tech','contractor_install','contractor_sales'].includes(currentUser.role),
    clients:          p.page_clients,
    calendar:         p.page_calendar && !outsourced,
    payments:         p.page_payments,
    ledger:           p.page_ledger !== undefined ? p.page_ledger : p.page_payments,
    expenses:         p.page_expenses !== undefined ? p.page_expenses : ['owner','hq_accounting'].includes(currentUser.role),
    subcontract:      p.page_subcontract !== undefined ? p.page_subcontract : ['owner','branch_manager','hq_accounting','hq_cs'].includes(currentUser.role),
    vendors:          ['owner','hq_accounting'].includes(currentUser.role),
    assets:           true,
    purchases:        p.page_materials !== undefined ? p.page_materials : mu,
    'material-usage': true,
    shipments:        ['owner','vp','hq_cs','hq_cs_manager'].includes(currentUser.role) || !!currentUser.can_ship,
    deficiencies:     true,   // 所有人可見（manager 看全部，員工看自己）
    leave:            true,
    feedback:         true,
    profile:          true,
    deposits:         p.page_deposits !== undefined ? p.page_deposits : p.page_payments,
    contracts:        true,
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
    marketing:           p.page_marketing    !== undefined ? p.page_marketing    : mu,
    'dispatch-pool':     p.page_dispatch_pool !== undefined ? p.page_dispatch_pool : mu,
    'quote-settings':    p.page_quote_settings !== undefined ? p.page_quote_settings : mu,
    'staff-performance': currentUser.role === 'owner',
    marketplace:      true,   // 市集所有人可見
    guide:            true,   // 系統使用說明所有人可見
    layout:           currentUser.role === 'owner' || !!mu || !!currentUser.can_layout,  // 排版工具：管理者或被授權者
  };
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    const page = el.dataset.page;
    if (page in pageMap && !pageMap[page]) el.style.display = 'none';
  });

  // 注入「完工回報」總覽選單（老闆 + 被授權者：客服/社群/小組長…），每頁只加一次
  (function() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-page="work-reports"]')) return;
    const can = currentUser.role === 'owner' || p.page_work_reports === true;
    if (!can) return;
    const a = document.createElement('a');
    a.className = 'nav-item'; a.dataset.page = 'work-reports'; a.href = '/work-reports';
    a.innerHTML = '<span class="icon">📋</span>完工回報';
    const anchor = nav.querySelector('[data-page="calendar"]') || nav.querySelector('[data-page="my-tasks"]');
    if (anchor) anchor.insertAdjacentElement('afterend', a); else nav.appendChild(a);
  })();
  // 注入「營運日報」選單（老闆/管理者），放在總覽下方
  (function() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-page="daily-report"]')) return;
    if (!(currentUser.role === 'owner' || mu)) return;
    const a = document.createElement('a');
    a.className = 'nav-item'; a.dataset.page = 'daily-report'; a.href = '/daily-report';
    a.innerHTML = '<span class="icon">🤖</span>營運日報';
    const anchor = nav.querySelector('[data-page="dashboard"]');
    if (anchor) anchor.insertAdjacentElement('afterend', a); else nav.appendChild(a);
  })();
  // 注入「AI 顧問」選單：老闆(特助顧問)、會計/財務權限者(會計顧問) 皆可進入，頁內再依權限過濾顧問頁籤
  (function() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-page="ai-advisor"]')) return;
    const p = currentUser.permissions || {};
    const r = currentUser.role;
    const canAdvisor = !outsourced && (r === 'owner'
      || r === 'hq_accounting' || p.page_ledger === true                 // 會計顧問
      || r === 'vp' || r === 'hq_cs' || r === 'hq_cs_manager' || p.page_calendar === true); // 派單顧問
    if (!canAdvisor) return;
    const a = document.createElement('a');
    a.className = 'nav-item'; a.dataset.page = 'ai-advisor'; a.href = '/ai-advisor';
    a.innerHTML = '<span class="icon">🤝</span>AI 顧問';
    const anchor = nav.querySelector('[data-page="daily-report"]') || nav.querySelector('[data-page="dashboard"]');
    if (anchor) anchor.insertAdjacentElement('afterend', a); else nav.appendChild(a);
  })();

  // 注入「客服關懷記錄」選單：老闆看全部客服、客服維護自己的；放在 LINE 詢問下方
  (function() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-page="care-logs"]')) return;   // 本頁已硬寫則略過
    const p = currentUser.permissions || {};
    const canCare = currentUser.role === 'owner' || p.page_care_logs === true;   // 依「客服關懷記錄」權限
    if (!canCare) return;
    const a = document.createElement('a');
    a.className = 'nav-item'; a.dataset.page = 'care-logs'; a.href = '/care-logs';
    a.innerHTML = '<span class="icon">💗</span>客服關懷記錄';
    const anchor = nav.querySelector('[data-page="line-inquiries"]') || nav.querySelector('[data-page="my-tasks"]');
    if (anchor) anchor.insertAdjacentElement('afterend', a); else nav.appendChild(a);
  })();

  // 注入「Google 雲端／備份」選單（僅老闆）：行事曆同步、雲端備份、重複日曆診斷/整理
  (function() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-page="gdrive-connect"]')) return;
    if (currentUser.role !== 'owner') return;
    const a = document.createElement('a');
    a.className = 'nav-item'; a.dataset.page = 'gdrive-connect'; a.href = '/gdrive-connect';
    a.innerHTML = '<span class="icon">☁️</span>Google 雲端／備份';
    const anchor = nav.querySelector('[data-page="admin"]') || nav.querySelector('[data-page="guide"]');
    if (anchor) anchor.insertAdjacentElement('afterend', a); else nav.appendChild(a);
  })();

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
    // 不論登出請求成功/失敗/逾時，都一定要導向（手機網路不穩時也能登出）
    try {
      await Promise.race([
        fetch('/api/auth/logout', { method: 'POST', keepalive: true }),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    } catch (e) { /* 忽略，仍導向登出 */ }
    location.href = '/';
  });

  // ── 手機版漢堡選單 ──────────────────────────────────────
  const topBar  = document.querySelector('.top-bar');
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    // 注入背景遮罩
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    // 注入漢堡按鈕；有 top-bar 就插進去，沒有 top-bar 的頁面（個人資料/合約/使用說明）
    // 改用浮動按鈕，避免手機上叫不出選單、被困在該頁回不去
    const btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', '選單');
    btn.innerHTML = '<span></span><span></span><span></span>';
    if (topBar) topBar.insertBefore(btn, topBar.firstChild);
    else { btn.classList.add('mobile-menu-btn-floating'); document.body.appendChild(btn); }

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

    // ── 萬用搜尋（跨 5 階段找案件）──────────────────────────
    const gWrap = document.createElement('div');
    gWrap.className = 'gsearch-wrap';
    gWrap.innerHTML = `
      <span class="gsearch-icon">🔍</span>
      <input type="text" id="gsearchInput" class="gsearch-input"
             placeholder="搜尋案號 / 客戶 / 電話 / 業務 / 分店…" autocomplete="off">
      <div class="gsearch-dropdown" id="gsearchDropdown" style="display:none"></div>`;
    topBar.appendChild(gWrap);

    const gInput = gWrap.querySelector('#gsearchInput');
    const gDrop  = gWrap.querySelector('#gsearchDropdown');
    const STAGE_CLS = { line:'gs-line', inq:'gs-inq', survey:'gs-survey', quote:'gs-quote', deal:'gs-deal' };
    let gTimer = null, gOpen = false;

    const gClose = () => { gOpen = false; gDrop.style.display = 'none'; };

    function gRender(data) {
      const rows = data.results || [];
      if (!rows.length) {
        gDrop.innerHTML = '<div class="gs-empty">查無資料</div>';
        gDrop.style.display = ''; gOpen = true; return;
      }
      gDrop.innerHTML = rows.map(r => {
        const cls = STAGE_CLS[r.stage] || 'gs-deal';
        const cno = r.case_number ? `<span class="gs-cno">${esc(r.case_number)}</span>` : '';
        const statusTxt = STATUS_LABELS[r.status] || (r.stage === 'line' ? '待處理' : '');
        let costTxt = '';
        if (r.cost != null) {
          const margin = r.gross_margin_pct != null ? ` · 毛利 ${r.gross_margin_pct}%` : '';
          costTxt = `<span class="gs-sep">·</span><span class="gs-cost">成本 ${fmt(r.cost)}${margin}</span>`;
        }
        const line2 = [esc(r.client_name || '—'), esc(r.phone || ''), esc(statusTxt)].filter(Boolean).join(' · ');
        const line3 = `🏢 ${esc(r.org_name || '—')} · 👤 業務：${esc(r.sales_name || '未指派')}`;
        return `<div class="gs-item" data-link="${esc(r.link)}">
          <span class="gs-badge ${cls}">${esc(r.stage_label)}</span>
          <span class="gs-info">
            <span class="gs-row1">${cno}${esc(r.title || '')}</span>
            <span class="gs-row2">${line2}${costTxt}</span>
            <span class="gs-row3">${line3}</span>
          </span>
        </div>`;
      }).join('');
      gDrop.style.display = ''; gOpen = true;
      gDrop.querySelectorAll('.gs-item').forEach(el =>
        el.addEventListener('click', () => { location.href = el.dataset.link; }));
    }

    async function gSearch(q) {
      try {
        const res = await fetch('/api/search/quick?q=' + encodeURIComponent(q));
        if (!res.ok) return;
        gRender(await res.json());
      } catch (e) { console.error('萬用搜尋失敗', e); }
    }

    gInput.addEventListener('input', () => {
      const q = gInput.value.trim();
      clearTimeout(gTimer);
      if (q.length < 1) { gClose(); return; }
      gTimer = setTimeout(() => gSearch(q), 250);
    });
    gInput.addEventListener('focus', () => {
      if (gInput.value.trim() && gDrop.innerHTML) { gDrop.style.display = ''; gOpen = true; }
    });
    gInput.addEventListener('keydown', e => { if (e.key === 'Escape') { gClose(); gInput.blur(); } });
    document.addEventListener('click', e => { if (gOpen && !gWrap.contains(e.target)) gClose(); });

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

  function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function loadNotifications() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const data = await res.json();
      const notifications = data.notifications || [];
      const unread = data.unread || 0;
      const badge = document.getElementById('notifBadge');
      if (badge) { badge.textContent = unread; badge.style.display = unread > 0 ? '' : 'none'; }
      const list = document.getElementById('notifList');
      if (!list) return;
      if (!notifications.length) { list.innerHTML = '<div class="notif-empty">暫無通知</div>'; return; }
      list.innerHTML = notifications.map(n => {
        const url = n.url ? esc(n.url) : '#';
        const body = esc(n.body||'').replace(/\n/g,'<br>');
        const time = (n.created_at||'').slice(0,16).replace('T',' ');
        return `<div class="notif-item${n.is_read ? '' : ' unread'}" onclick="location.href='${url}'">
          <div class="notif-title">${esc(n.title)}</div>
          <div class="notif-body">${body}</div>
          <div class="notif-time">${time}</div>
        </div>`;
      }).join('');
    } catch(e) {
      const list = document.getElementById('notifList');
      if (list) list.innerHTML = '<div class="notif-empty">通知載入失敗</div>';
    }
  }

  // 定時刷新未讀數（每 60 秒）
  async function refreshNotifBadge() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const data = await res.json();
      const unread = data.unread || 0;
      const badge = document.getElementById('notifBadge');
      if (badge) { badge.textContent = unread; badge.style.display = unread > 0 ? '' : 'none'; }
    } catch(e) { /* silent */ }
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
