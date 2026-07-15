/* 繪新膜料牌價表 —— 共用渲染引擎（估價牌價 est_film_catalog）
   版型參考公司實體「裝潢貼膜價格表」：品牌抬頭 + 防焰/不防焰分區 + 每米價 + 連工帶料三檔 + 底部說明。
   不顯示成本/毛利（老闆請看報價設定）。 */
(function () {
  const ORDER = ['paroi', 'benif', 'bodaq', '3m'];
  const BRANDS = {
    paroi: { name: 'PAROI', sub: '日本 LINTEC', c1: '#6f5122', c2: '#b58a45', soft: '#f6efe2', freight: 'jp', korean: false },
    benif: { name: 'BENIF', sub: 'LX Hausys（LG）· 韓國', c1: '#41560f', c2: '#7f9d33', soft: '#eef3df', freight: 'kr', korean: true },
    bodaq: { name: 'Bodaq', sub: 'HYUNDAI · 韓國', c1: '#4a1178', c2: '#d4148a', soft: '#f7e6f4', freight: 'kr', korean: true },
    '3m': { name: '3M', sub: 'DI-NOC 特耐軟片', c1: '#9c0f22', c2: '#e11f33', soft: '#fbe7e9', freight: null, korean: false },
  };
  const FREIGHT_NOTE = {
    kr: ['空運 $6,000／一款（約 2–10 工作天，不含假日）', '海運 $3,000／一款（約 20–30 工作天，不含假日）'],
    jp: ['空運 $6,000／一款（約 3–4 週，不含假日）'],
  };
  const NOTES_WORK = [
    '膜料寬度皆為 122 公分（PS 石膏 93 公分）。',
    '電梯／消防栓／門（消防門、大門等）／窗框等物件皆以「座」計價。',
    '倒吊天花板、特殊造型、高空作業（300 公分以上）需加價 20／才起。',
    '雙北、桃園以外地區車馬費另計，請參照車馬費表。報價不含底板整平補土打磨、矽利康清除及重打、清除底紙等費用。',
    '夜間施工、假日施工、過夜施工另計，依案件狀況報價。',
  ];
  const LOWMIN_NOTE = [
    '現貨施工低消：單趟一萬未稅。',
    '期貨施工低消：單趟一萬未稅，期貨運費另計。',
    '設計師優惠：單一案件連工帶料滿五萬，可免一支期貨運費。',
  ];

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ecomOf = p => Math.round((Number(p) || 0) * 1.05 / 50) * 50;
  const nt = n => '$' + (Math.round(Number(n) || 0)).toLocaleString('en-US');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return; cssInjected = true;
    const css = `
    .ps-sheet{--c1:#4a1178;--c2:#d4148a;--soft:#f7e6f4;background:var(--paper,#fff);border-radius:18px;
      overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.06),0 18px 50px rgba(0,0,0,.07);margin:0 auto 26px;max-width:1040px}
    .ps-head{display:flex;align-items:center;gap:16px;padding:20px 26px;
      background:linear-gradient(110deg,var(--c1),var(--c2));color:#fff;position:relative}
    .ps-head img{height:44px;width:44px;object-fit:contain;filter:brightness(0) invert(1);opacity:.96;flex-shrink:0}
    .ps-head .wm{font-size:30px;font-weight:900;letter-spacing:1px;line-height:1}
    .ps-head .wm small{display:block;font-size:11px;font-weight:600;letter-spacing:3px;opacity:.85;margin-top:3px}
    .ps-head .title{font-size:24px;font-weight:900;letter-spacing:4px;margin-left:6px}
    .ps-head .date{margin-left:auto;text-align:right;font-size:12px;opacity:.9;font-weight:600;letter-spacing:1px}
    .ps-grp{display:flex;border-top:1px solid var(--line,#ece7ef)}
    .ps-band{flex:0 0 40px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;
      font-size:17px;letter-spacing:3px;writing-mode:vertical-rl;text-orientation:upright;
      background:var(--c1)}
    .ps-band.nf{background:color-mix(in srgb,var(--c1) 62%,#8a8a8a)}
    .ps-gtbl{flex:1;overflow-x:auto}
    table.ps-tbl{width:100%;border-collapse:collapse;font-size:13.5px;min-width:640px}
    table.ps-tbl th{background:var(--soft);color:var(--c1);font-weight:800;font-size:12px;letter-spacing:.5px;
      padding:10px 8px;text-align:center;border:1px solid var(--line,#ece7ef);line-height:1.35}
    table.ps-tbl td{padding:9px 8px;text-align:center;border:1px solid var(--line,#ece7ef);
      font-variant-numeric:tabular-nums;color:var(--ink,#241f29)}
    table.ps-tbl tbody tr:nth-child(even) td{background:var(--zebra,#faf7fb)}
    .ps-code{font-weight:800;letter-spacing:.4px}
    .ps-kr{color:var(--sub,#8a8390)}
    .ps-color{color:var(--sub2,#5f5866)}
    .ps-perm{background:linear-gradient(120deg,var(--c1),var(--c2));color:#fff;font-weight:900;font-size:15px}
    .ps-perm small{display:block;font-weight:600;font-size:10.5px;opacity:.9;margin-top:1px}
    .ps-cai{font-weight:700}
    .ps-notes{padding:6px 22px 22px}
    .ps-note{display:flex;gap:0;border:1px solid var(--line,#ece7ef);border-radius:12px;overflow:hidden;margin-top:12px}
    .ps-note .lb{flex:0 0 96px;background:var(--soft);color:var(--c1);font-weight:800;font-size:13px;
      display:flex;align-items:center;justify-content:center;text-align:center;padding:10px}
    .ps-note ul{margin:0;padding:11px 16px 11px 30px;font-size:12.5px;color:var(--sub2,#5f5866);line-height:1.7}
    .ps-note li{margin:1px 0}
    @media(max-width:560px){.ps-head .wm{font-size:23px}.ps-head .title{font-size:18px;letter-spacing:2px}.ps-head img{height:34px;width:34px}}
    `;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  // 只依「防焰／不防焰」分組（韓國/亞洲版是同一列的兩套代碼，用欄位呈現，不另分區）
  function groupRows(rows) {
    const groups = [];
    const order = {};
    rows.slice().sort((a, b) => {
      const fa = a.fireproof === '防焰' ? 1 : 0, fb = b.fireproof === '防焰' ? 1 : 0; if (fa !== fb) return fa - fb;
      return (a.sort_order || 0) - (b.sort_order || 0);
    }).forEach(r => {
      const k = r.fireproof || '';
      if (!(k in order)) { order[k] = groups.length; groups.push({ fireproof: k, rows: [] }); }
      groups[order[k]].rows.push(r);
    });
    return groups;
  }

  function rowHtml(r, brand, customer, korean) {
    const is3m = brand === '3m';
    const ecom = is3m ? (Number(r.per_m) || 0) : (Number(r.ecom_price) || ecomOf(r.per_m));
    const permCell = is3m
      ? `<td class="ps-perm">${nt(ecom)}<small>未稅</small></td>`
      : `<td class="ps-perm">${nt(ecom)}${customer ? '' : `<small>未稅 ${nt(r.per_m)}</small>`}</td>`;
    const krCol = korean ? `<td class="ps-code ps-kr">${esc(r.kr_code || '—')}</td>` : '';
    return `<tr>
      <td class="ps-code">${esc(r.asia_code || '—')}</td>
      ${krCol}
      <td class="ps-color">${esc(r.color || '—')}</td>
      <td>${r.roll_len || 50}</td>
      ${permCell}
      <td class="ps-cai">${nt(r.plane)}</td>
      <td class="ps-cai">${nt(r.cabinet)}</td>
      <td class="ps-cai">${nt(r.shape)}</td>
    </tr>`;
  }

  function tblHtml(rows, brand, customer, korean) {
    const krTh = korean ? '<th>韓國系列</th>' : '';
    const codeTh = korean ? '亞洲系列' : '系列／型號';
    return `<table class="ps-tbl"><thead><tr>
      <th>${codeTh}</th>${krTh}<th>花色</th><th>規格<br>(米)</th>
      <th>每米 $</th><th>連工帶料<br>全平面牆面</th><th>系統櫃<br>門片</th><th>連工帶料<br>造型</th>
    </tr></thead><tbody>${rows.map(r => rowHtml(r, brand, customer, korean)).join('')}</tbody></table>`;
  }

  function notesHtml(brand) {
    const f = BRANDS[brand].freight;
    const freight = f ? FREIGHT_NOTE[f] : ['3M 為現貨供應，無期貨運費。'];
    const blk = (lb, arr) => `<div class="ps-note"><div class="lb">${lb}</div><ul>${arr.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
    return `<div class="ps-notes">
      ${blk('低消說明', LOWMIN_NOTE)}
      ${blk('期貨運費<br>說明', freight)}
      ${blk('施工費<br>說明', NOTES_WORK)}
    </div>`;
  }

  // 產生單一品牌的牌價表 HTML
  function renderSheet(brand, rows, opts) {
    injectCss();
    opts = opts || {};
    const b = BRANDS[brand]; if (!b) return '';
    const korean = !!b.korean;
    const groups = groupRows(rows);
    const body = groups.map(g => {
      const tbl = tblHtml(g.rows, brand, opts.customer, korean);
      if (!g.fireproof) return `<div class="ps-grp"><div class="ps-gtbl">${tbl}</div></div>`;  // 無防焰分類→整塊不加側欄
      const nf = g.fireproof !== '防焰';
      return `<div class="ps-grp">
        <div class="ps-band ${nf ? 'nf' : ''}">${esc(g.fireproof)}</div>
        <div class="ps-gtbl">${tbl}</div>
      </div>`;
    }).join('');
    return `<div class="ps-sheet" style="--c1:${b.c1};--c2:${b.c2};--soft:${b.soft}" data-brand="${brand}">
      <div class="ps-head">
        <img src="/logo.png" alt="繪新">
        <div class="wm">${b.name}<small>${esc(b.sub)}</small></div>
        <div class="title">裝潢貼膜價格表</div>
        <div class="date">繪新國際<br>更新日 ${todayStr()}</div>
      </div>
      ${body || '<div style="padding:40px;text-align:center;color:#9ca3af">此品牌尚無牌價資料</div>'}
      ${notesHtml(brand)}
    </div>`;
  }

  async function fetchData() {
    const r = await fetch('/api/price-list');
    if (!r.ok) throw new Error('load failed');
    const d = await r.json();
    const byBrand = {}; ORDER.forEach(k => byBrand[k] = []);
    (d.films || []).forEach(f => { if (byBrand[f.brand]) byBrand[f.brand].push(f); });
    return byBrand;
  }

  window.PriceSheet = { ORDER, BRANDS, renderSheet, fetchData };
})();
