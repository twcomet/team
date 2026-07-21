/* 切料回報（共用元件）：切料人完工直接回報，不用先領用。
   每列＝一支捲：選哪一支 → 自動帶「領用時剩餘米」→ 填「切了幾米」→ 送出直接扣該支庫存、記到案件。
   用法：CutReport.open(caseId, caseLabel, onDone). 後端走 POST /api/material-usage/（purpose_code=case_material＝直接扣料）。 */
(function () {
  let ROLLS = [], CASE = null, LABEL = '', DONE = null, mounted = false;

  function ensure() {
    if (mounted) return;
    mounted = true;
    const css = `
      #cutModal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:none;align-items:center;justify-content:center;padding:14px}
      #cutModal.on{display:flex}
      .cut-box{background:#fff;border-radius:16px;width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px -18px rgba(0,0,0,.4)}
      .cut-hd{padding:15px 20px;background:#3a2540;color:#fff;display:flex;align-items:center;justify-content:space-between}
      .cut-hd b{font-size:16px} .cut-hd .x{cursor:pointer;font-size:20px;opacity:.85}
      .cut-bd{padding:14px 18px;overflow-y:auto;flex:1}
      .cut-row{display:grid;grid-template-columns:1fr 92px 92px 26px;gap:8px;align-items:end;margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #eee}
      .cut-row label{display:block;font-size:11px;color:#6b7280;margin-bottom:3px}
      .cut-row input{width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid #d1d5db;border-radius:8px;font-size:13px}
      .cut-row .rm{border:none;background:#fee2e2;color:#dc2626;border-radius:7px;height:34px;cursor:pointer;font-size:14px}
      .cut-remain{font-size:11px;color:#1f8a5b;margin-top:2px;min-height:14px}
      .cut-add{width:100%;padding:9px;border:1px dashed #c4b5fd;background:#f5f3ff;color:#6d28d9;border-radius:9px;font-weight:700;cursor:pointer;font-size:13px}
      .cut-ft{padding:12px 18px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;gap:10px}
      .cut-ft .btn{border:none;border-radius:9px;padding:10px 18px;font-weight:800;cursor:pointer;font-size:14px}
      .cut-ft .go{background:#D40069;color:#fff} .cut-ft .go:disabled{background:#d1d5db;cursor:not-allowed}
      .cut-ft .cc{background:#f3f4f6;color:#374151}
      .cut-msg{font-size:12px}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const m = document.createElement('div'); m.id = 'cutModal';
    m.innerHTML = `<div class="cut-box">
        <div class="cut-hd"><b>🪚 切料回報</b><span class="x" onclick="CutReport.close()">✕</span></div>
        <div class="cut-bd">
          <div style="font-size:12px;color:#6b7280;margin-bottom:10px" id="cutCase"></div>
          <datalist id="cutRolls"></datalist>
          <div id="cutRows"></div>
          <button type="button" class="cut-add" onclick="CutReport.addRow()">＋ 再切一支</button>
        </div>
        <div class="cut-ft"><span class="cut-msg" id="cutMsg"></span>
          <div style="display:flex;gap:8px"><button class="btn cc" onclick="CutReport.close()">取消</button><button class="btn go" id="cutGo" onclick="CutReport.submit()">送出（直接扣庫存）</button></div>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) close(); });
  }

  const rollLabel = r => `${r.brand} ${r.model}${r.color ? ' ' + r.color : ''}｜架${r.location || '—'}｜剩${(r.remaining_meters || 0).toFixed ? (r.remaining_meters).toFixed(1) : r.remaining_meters}米 #${r.roll_id}`;

  function addRow(preset) {
    const box = document.getElementById('cutRows');
    const i = box.children.length;
    const d = document.createElement('div'); d.className = 'cut-row'; d.dataset.i = i;
    d.innerHTML = `
      <div><label>切哪一支（打字搜尋型號/花色/架位）</label>
        <input class="cr-roll" list="cutRolls" placeholder="選捲…" oninput="CutReport.onRoll(this)"><div class="cut-remain"></div></div>
      <div><label>領用時米</label><input class="cr-req" type="number" step="0.1" placeholder="自動"></div>
      <div><label>切了幾米</label><input class="cr-cut" type="number" step="0.1" placeholder="0"></div>
      <button type="button" class="rm" onclick="this.closest('.cut-row').remove()">✕</button>`;
    box.appendChild(d);
  }

  function onRoll(inp) {
    const row = inp.closest('.cut-row');
    const m = String(inp.value).match(/#(\d+)\s*$/);
    let r = null;
    if (m) r = ROLLS.find(x => String(x.roll_id) === m[1]);
    else { const key = inp.value.trim(); r = ROLLS.find(x => rollLabel(x) === inp.value) || null; }
    const rem = row.querySelector('.cut-remain'), req = row.querySelector('.cr-req');
    if (r) { rem.textContent = `目前剩餘 ${Number(r.remaining_meters).toFixed(1)} 米`; if (!req.value) req.value = Number(r.remaining_meters).toFixed(1); row.dataset.roll = r.roll_id; row.dataset.mid = r.material_id; row.dataset.lbl = `${r.brand} ${r.model}${r.color ? ' ' + r.color : ''}`; }
    else { rem.textContent = ''; delete row.dataset.roll; }
  }

  async function open(caseId, caseLabel, onDone) {
    ensure(); CASE = caseId; LABEL = caseLabel || ''; DONE = onDone || null;
    document.getElementById('cutCase').textContent = '案件：' + (LABEL || ('#' + caseId));
    document.getElementById('cutMsg').textContent = '載入捲料中…';
    document.getElementById('cutRows').innerHTML = '';
    try { ROLLS = await fetch('/api/material-usage/rolls').then(r => r.ok ? r.json() : []); }
    catch (e) { ROLLS = []; }
    document.getElementById('cutRolls').innerHTML = ROLLS.map(r => `<option value="${rollLabel(r).replace(/"/g, '&quot;')}"></option>`).join('');
    document.getElementById('cutMsg').textContent = ROLLS.length ? '' : '查無可用捲料（庫存為 0）';
    addRow();
    document.getElementById('cutModal').classList.add('on');
  }
  function close() { const m = document.getElementById('cutModal'); if (m) m.classList.remove('on'); }

  async function submit() {
    const rows = [...document.querySelectorAll('#cutRows .cut-row')];
    const items = [];
    for (const row of rows) {
      const roll = row.dataset.roll;
      const cut = parseFloat(row.querySelector('.cr-cut').value);
      if (!roll) continue;
      if (!(cut > 0)) { document.getElementById('cutMsg').textContent = '每一支都要填「切了幾米」（>0）'; return; }
      const req = parseFloat(row.querySelector('.cr-req').value);
      items.push({ roll_id: Number(roll), material_id: Number(row.dataset.mid), material_label: row.dataset.lbl,
        est_meters: isNaN(req) ? null : req, actual_meters: cut });
    }
    if (!items.length) { document.getElementById('cutMsg').textContent = '請至少選一支並填切了幾米'; return; }
    const go = document.getElementById('cutGo'); go.disabled = true; document.getElementById('cutMsg').textContent = '送出中…';
    let ok = 0;
    try {
      for (const it of items) {
        const r = await fetch('/api/material-usage/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ material_label: it.material_label, material_id: it.material_id, roll_id: it.roll_id,
            case_id: CASE, purpose: '案場切料', purpose_code: 'case_material',
            est_meters: it.est_meters, actual_meters: it.actual_meters }) });
        if (r.ok) ok++;
      }
      document.getElementById('cutMsg').textContent = `✓ 已回報 ${ok}/${items.length} 支、已扣庫存`;
      setTimeout(() => { close(); if (DONE) DONE(ok); }, 900);
    } catch (e) { document.getElementById('cutMsg').textContent = '送出失敗，請重試'; }
    finally { go.disabled = false; }
  }

  window.CutReport = { open, close, addRow, onRoll, submit };
})();
