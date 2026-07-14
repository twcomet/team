// 共用元件：客服關懷記錄清單 + 新增/編輯（LINE 詢問、我的任務都掛同一份，資料同步案件 Tab）
// 用法：CareLogs.mount('containerId', { title:'客服關懷記錄' })
(function () {
  const ACT = { message: '💬 訊息', call: '📞 電聯', other: '📝 其他' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function fmtTime(s) { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
  function toast(msg, type) { if (window.showToast) return showToast(msg, type); alert(msg); }

  let _users = null;
  async function users() { if (_users) return _users; try { const r = await fetch('/api/users'); _users = r.ok ? await r.json() : []; } catch (e) { _users = []; } return _users; }

  const S = { container: null, scope: 'mine', q: '', canSeeAll: false, rows: [], editId: null, pickCaseId: null, pickCaseLabel: '' };

  function nfuBadge(nfu) {
    if (!nfu) return '';
    const t = todayStr();
    let col, txt;
    if (nfu < t) { col = '#d93025'; txt = '⏰ 逾期 ' + nfu; }
    else if (nfu === t) { col = '#e37400'; txt = '⏰ 今天 ' + nfu; }
    else { col = '#1a73e8'; txt = '📅 ' + nfu; }
    return `<span style="display:inline-block;background:${col}1a;color:${col};border-radius:5px;padding:1px 7px;font-size:12px;font-weight:600;white-space:nowrap">${txt}</span>`;
  }

  function render() {
    const rows = S.rows;
    const head = `
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <input id="clSearch" placeholder="🔍 搜尋案號／客戶／備註／客服" value="${esc(S.q)}" autocomplete="off"
          style="flex:1;min-width:180px;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px">
        ${S.canSeeAll ? `<label style="font-size:13px;color:#5f6368;display:flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer"><input type="checkbox" id="clScopeAll" ${S.scope === 'all' ? 'checked' : ''}> 看全部客服</label>` : ''}
        <button id="clAddBtn" class="btn btn-primary btn-sm" style="white-space:nowrap">＋ 新增客服關懷記錄</button>
      </div>`;
    let body;
    if (!rows.length) {
      body = `<div style="color:#80868b;padding:24px;text-align:center;font-size:14px">目前沒有${S.scope === 'mine' ? '你負責的' : ''}關懷記錄</div>`;
    } else {
      body = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#5f6368;border-bottom:1px solid #e8eaed">
          <th style="padding:8px 10px;font-weight:600;white-space:nowrap">時間</th>
          <th style="padding:8px 10px;font-weight:600">案件</th>
          <th style="padding:8px 10px;font-weight:600;white-space:nowrap">處理</th>
          <th style="padding:8px 10px;font-weight:600;white-space:nowrap">客服</th>
          <th style="padding:8px 10px;font-weight:600;white-space:nowrap">下次關懷</th>
          <th style="padding:8px 10px;font-weight:600">摘要</th>
          <th style="padding:8px 10px"></th>
        </tr></thead><tbody>` +
        rows.map(r => `<tr style="border-bottom:1px solid #f1f3f4">
          <td style="padding:8px 10px;color:#80868b;white-space:nowrap">${esc(fmtTime(r.created_at))}</td>
          <td style="padding:8px 10px"><a href="/case-detail?id=${r.case_id}" style="color:#1a73e8;text-decoration:none">${esc(r.case_number || '')}</a> <span style="color:#3c4043">${esc([r.client_name, r.case_title].filter(Boolean).join(' ')).slice(0, 28)}</span></td>
          <td style="padding:8px 10px;white-space:nowrap">${ACT[r.action] || esc(r.action || '')}</td>
          <td style="padding:8px 10px;white-space:nowrap">${esc(r.cs_name || '—')}</td>
          <td style="padding:8px 10px">${nfuBadge(r.next_follow_up)}</td>
          <td style="padding:8px 10px;color:#3c4043;max-width:280px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.memo || '')}</div></td>
          <td style="padding:8px 10px;white-space:nowrap"><button class="cl-edit" data-id="${r.id}" style="border:1px solid #dadce0;background:#fff;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer">編輯</button></td>
        </tr>`).join('') + `</tbody></table></div>`;
    }
    S.container.innerHTML = head + body;
    const si = document.getElementById('clSearch');
    si.oninput = () => { S.q = si.value.trim(); clearTimeout(S._t); S._t = setTimeout(load, 250); };
    const sa = document.getElementById('clScopeAll'); if (sa) sa.onchange = () => { S.scope = sa.checked ? 'all' : 'mine'; load(); };
    document.getElementById('clAddBtn').onclick = () => openModal(null);
    S.container.querySelectorAll('.cl-edit').forEach(b => b.onclick = () => openModal(S.rows.find(x => x.id == b.dataset.id)));
  }

  async function load() {
    if (!S.container) return;
    try {
      const r = await fetch(`/api/care-logs?scope=${S.scope}&q=${encodeURIComponent(S.q)}`);
      const j = await r.json();
      S.rows = j.results || []; S.canSeeAll = !!j.canSeeAll; S.scope = j.scope || S.scope;
    } catch (e) { S.rows = []; }
    render();
  }

  // ── 新增/編輯 Modal ──────────────────────────────────────────
  function ensureModal() {
    if (document.getElementById('clModal')) return;
    const d = document.createElement('div');
    d.id = 'clModal';
    d.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto';
    d.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 12px 48px rgba(0,0,0,.25)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #eef0f3">
        <h3 id="clmTitle" style="margin:0;font-size:17px">新增客服關懷記錄</h3>
        <button onclick="CareLogs._close()" style="border:none;background:none;font-size:22px;cursor:pointer;color:#5f6368">×</button>
      </div>
      <div style="padding:18px 20px">
        <div id="clmCaseWrap">
          <div style="display:flex;gap:14px;margin-bottom:8px;font-size:13px">
            <label style="cursor:pointer"><input type="radio" name="clmCaseMode" value="pick" checked onchange="CareLogs._mode('pick')"> 搜尋既有案件</label>
            <label style="cursor:pointer"><input type="radio" name="clmCaseMode" value="new" onchange="CareLogs._mode('new')"> 開新案件</label>
          </div>
          <div id="clmPickBox">
            <input id="clmCaseSearch" placeholder="輸入案號／客戶／電話搜尋…" autocomplete="off" oninput="CareLogs._searchCase()"
              style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px">
            <div id="clmCaseResults" style="border:1px solid #eee;border-radius:8px;margin-top:4px;max-height:180px;overflow:auto;display:none"></div>
            <div id="clmPicked" style="margin-top:6px;font-size:13px;color:#137333"></div>
          </div>
          <div id="clmNewBox" style="display:none">
            <input id="clmNewTitle" placeholder="案件名稱（例：北投/電梯/社區總幹事-翁主任）"
              style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px;margin-bottom:8px">
            <input id="clmNewClient" placeholder="客戶名稱（選填）"
              style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px">
          </div>
        </div>
        <hr style="border:none;border-top:1px solid #f1f3f4;margin:16px 0">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <label style="font-size:12px;color:#5f6368">客服人員<select id="clmUser" style="width:100%;padding:8px;border:1px solid #dadce0;border-radius:8px;font-size:14px;margin-top:4px"></select></label>
          <label style="font-size:12px;color:#5f6368">處理事項<select id="clmAction" style="width:100%;padding:8px;border:1px solid #dadce0;border-radius:8px;font-size:14px;margin-top:4px">
            <option value="message">💬 訊息</option><option value="call">📞 電聯</option><option value="other">📝 其他</option></select></label>
        </div>
        <label style="font-size:12px;color:#5f6368">備註 Memo<textarea id="clmMemo" rows="3" placeholder="例：已電聯客戶，確認要轉場勘"
          style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px;margin-top:4px;resize:vertical"></textarea></label>
        <label style="font-size:12px;color:#5f6368;display:block;margin-top:12px">下次關懷時間（會出現在你的「我的任務」提醒）
          <input type="date" id="clmNfu" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:14px;margin-top:4px"></label>
      </div>
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;padding:14px 20px;border-top:1px solid #eef0f3">
        <button id="clmDelete" onclick="CareLogs._delete()" style="border:none;background:none;color:#d93025;cursor:pointer;display:none">🗑️ 刪除</button>
        <span style="flex:1"></span>
        <button onclick="CareLogs._close()" style="border:1px solid #dadce0;background:#fff;border-radius:8px;padding:8px 16px;cursor:pointer">取消</button>
        <button id="clmSave" onclick="CareLogs._save()" class="btn btn-primary">儲存</button>
      </div>
    </div>`;
    document.body.appendChild(d);
  }

  async function openModal(log) {
    ensureModal();
    S.editId = log ? log.id : null;
    S.pickCaseId = log ? log.case_id : null;
    S.pickCaseLabel = log ? `${log.case_number || ''} ${log.client_name || ''}`.trim() : '';
    document.getElementById('clmTitle').textContent = log ? '編輯客服關懷記錄' : '新增客服關懷記錄';
    // 客服人員清單
    const us = await users();
    document.getElementById('clmUser').innerHTML = us.filter(u => u.active !== 0).map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    document.getElementById('clmUser').value = log ? (log.cs_user_id || '') : (window.currentUser && currentUser.id) || '';
    document.getElementById('clmAction').value = log ? (log.action || 'other') : 'message';
    document.getElementById('clmMemo').value = log ? (log.memo || '') : '';
    document.getElementById('clmNfu').value = log ? (log.next_follow_up || '') : '';
    document.getElementById('clmDelete').style.display = log ? '' : 'none';
    // 編輯時案件固定顯示、不可改；新增時可挑/開新
    const caseWrap = document.getElementById('clmCaseWrap');
    if (log) {
      caseWrap.innerHTML = `<div style="font-size:13px;color:#5f6368">案件</div><div style="font-weight:600;margin-top:2px"><a href="/case-detail?id=${log.case_id}" style="color:#1a73e8;text-decoration:none">${esc(log.case_number || '')}</a> ${esc(log.client_name || '')} ${esc(log.case_title || '')}</div>`;
    }
    document.getElementById('clModal').style.display = 'flex';
  }

  async function searchCase() {
    const q = document.getElementById('clmCaseSearch').value.trim();
    const box = document.getElementById('clmCaseResults');
    if (!q) { box.style.display = 'none'; return; }
    clearTimeout(S._ct);
    S._ct = setTimeout(async () => {
      let cases = [];
      try { const d = await (await fetch('/api/search/quick?q=' + encodeURIComponent(q))).json(); cases = (d.results || []).filter(x => x.type === 'case'); } catch (e) { }
      if (!cases.length) { box.innerHTML = '<div style="padding:10px;color:#80868b;font-size:13px">找不到案件</div>'; box.style.display = 'block'; return; }
      box.innerHTML = cases.slice(0, 20).map(c => `<div class="clm-cr" data-id="${c.id}" data-label="${esc((c.case_number || '') + ' ' + (c.client_name || ''))}" style="padding:9px 12px;border-bottom:1px solid #f1f3f4;cursor:pointer;font-size:13px">
        <b>${esc(c.case_number || '')}</b> ${esc(c.client_name || '')} <span style="color:#80868b">${esc(c.title || '')}</span></div>`).join('');
      box.querySelectorAll('.clm-cr').forEach(el => el.onclick = () => {
        S.pickCaseId = +el.dataset.id; S.pickCaseLabel = el.dataset.label;
        document.getElementById('clmPicked').textContent = '✓ 已選：' + el.dataset.label;
        box.style.display = 'none'; document.getElementById('clmCaseSearch').value = el.dataset.label;
      });
      box.style.display = 'block';
    }, 250);
  }

  async function save() {
    const btn = document.getElementById('clmSave'); btn.disabled = true;
    try {
      let caseId = S.pickCaseId;
      // 開新案件
      const modeNew = document.querySelector('input[name=clmCaseMode]:checked') && document.querySelector('input[name=clmCaseMode]:checked').value === 'new';
      if (!S.editId && modeNew) {
        const title = document.getElementById('clmNewTitle').value.trim();
        const client = document.getElementById('clmNewClient').value.trim();
        if (!title) { toast('請填寫案件名稱', 'error'); btn.disabled = false; return; }
        const cr = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description: client ? '客戶：' + client : null }) });
        const cj = await cr.json();
        if (!cr.ok || !cj.id) { toast('建立案件失敗：' + (cj.error || ''), 'error'); btn.disabled = false; return; }
        caseId = cj.id;
      }
      if (!S.editId && !caseId) { toast('請選擇既有案件或開新案件', 'error'); btn.disabled = false; return; }
      const payload = {
        cs_user_id: document.getElementById('clmUser').value || null,
        action: document.getElementById('clmAction').value,
        memo: document.getElementById('clmMemo').value.trim(),
        next_follow_up: document.getElementById('clmNfu').value || null,
      };
      let r;
      if (S.editId) r = await fetch('/api/care-logs/' + S.editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      else r = await fetch('/api/care-logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case_id: caseId, ...payload }) });
      const j = await r.json();
      if (!r.ok) { toast(j.error || '儲存失敗', 'error'); btn.disabled = false; return; }
      toast(S.editId ? '已更新關懷記錄' : '已新增關懷記錄');
      close(); load();
    } catch (e) { toast('儲存失敗：' + e.message, 'error'); }
    finally { btn.disabled = false; }
  }

  async function del() {
    if (!S.editId) return;
    if (!confirm('確定刪除這筆關懷記錄？')) return;
    const r = await fetch('/api/care-logs/' + S.editId, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || '刪除失敗', 'error'); return; }
    toast('已刪除'); close(); load();
  }

  function close() { const m = document.getElementById('clModal'); if (m) m.style.display = 'none'; }
  function mode(v) {
    document.getElementById('clmPickBox').style.display = v === 'pick' ? '' : 'none';
    document.getElementById('clmNewBox').style.display = v === 'new' ? '' : 'none';
  }

  window.CareLogs = {
    mount(containerId, opts) {
      S.container = document.getElementById(containerId);
      if (!S.container) return;
      S.scope = (opts && opts.scope) || 'mine';
      load();
    },
    reload: load,
    _close: close, _save: save, _delete: del, _mode: mode, _searchCase: searchCase,
  };
})();
