/* 繪新膜料牌價表 —— 共用渲染引擎（估價牌價 est_film_catalog）
   版型參考公司實體「裝潢貼膜價格表」：品牌抬頭 + 防焰/不防焰側欄 + 每米價高亮 + 連工帶料三檔 + 底部說明。
   不顯示成本/毛利（老闆請看報價設定）。 */
(function () {
  const ORDER = ['paroi', 'benif', 'bodaq', '3m'];
  const BRANDS = {
    paroi: { name: 'PAROI', sub: '日本 LINTEC', c1: '#6f5122', c2: '#b58a45', soft: '#f6efe2', freight: 'jp' },
    benif: { name: 'BENIF', sub: 'LX Hausys（LG）· 韓國', c1: '#41560f', c2: '#7f9d33', soft: '#eef3df', freight: 'kr' },
    bodaq: { name: 'Bodaq', sub: 'HYUNDAI · 韓國', c1: '#4a1178', c2: '#d4148a', soft: '#f7e6f4', freight: 'kr' },
    '3m': { name: '3M', sub: 'DI-NOC 特耐軟片', c1: '#9c0f22', c2: '#e11f33', soft: '#fbe7e9', freight: null },
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
  const caiFactor = w => ((Number(w) || 122) * 100) / 900;                 // 每米→每才 換算係數（膜寬 cm × 100 ÷ 900）
  const perTsai = r => Math.round((Number(r.per_m) || 0) / caiFactor(r.width)); // 3M 每才牌價（未稅，比照報價設定）
  const priceOf = (r, is3m) => is3m ? perTsai(r) : (Number(r.ecom_price) || ecomOf(r.per_m)); // 3M 以每才、其餘以電商含稅/米
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return; cssInjected = true;
    const css = `
    .ps-sheet{background:#fff;border-radius:18px;overflow:hidden;
      box-shadow:0 4px 14px rgba(0,0,0,.06),0 20px 54px rgba(0,0,0,.08);margin:0 auto 26px;max-width:1060px}
    .ps-head{display:flex;align-items:center;gap:18px;padding:22px 28px;
      background:linear-gradient(115deg,var(--c1),var(--c2));color:#fff;position:relative}
    .ps-head img{height:46px;width:46px;object-fit:contain;filter:brightness(0) invert(1);opacity:.96;flex-shrink:0}
    .ps-head .wm{font-size:32px;font-weight:900;letter-spacing:1px;line-height:1}
    .ps-head .wm small{display:block;font-size:11px;font-weight:600;letter-spacing:3px;opacity:.88;margin-top:4px}
    .ps-head .title{font-size:25px;font-weight:900;letter-spacing:5px;margin-left:8px}
    .ps-head .date{margin-left:auto;text-align:right;font-size:12px;opacity:.92;font-weight:600;letter-spacing:1px;line-height:1.6}
    .ps-scroll{overflow-x:auto}
    .ps-sheet ::selection{background:#3a3340;color:#fff}
    .ps-sheet ::-moz-selection{background:#3a3340;color:#fff}
    table.ps-tbl{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px;table-layout:fixed}
    table.ps-tbl thead th{background:var(--soft);color:var(--c1);font-weight:800;font-size:12px;letter-spacing:.4px;
      padding:12px 8px;text-align:center;border-bottom:2px solid var(--c1);line-height:1.35;white-space:nowrap}
    table.ps-tbl thead th.ps-ph{background:linear-gradient(120deg,var(--c1),var(--c2));color:#fff;border-bottom-color:#fff}
    table.ps-tbl tbody td{padding:12px 12px;text-align:center;border-bottom:1px solid #eee;
      font-variant-numeric:tabular-nums;color:#241f29;line-height:1.4}
    table.ps-tbl tbody tr:last-child td{border-bottom:none}
    table.ps-tbl tbody tr:hover td:not(.ps-perm):not(.ps-band){background:var(--soft)}
    td.ps-band{writing-mode:vertical-rl;text-orientation:upright;background:var(--c1);color:#fff;
      font-weight:900;font-size:16px;letter-spacing:5px;width:46px;padding:8px 4px;text-align:center;
      vertical-align:middle;border-bottom:2px solid #fff}
    td.ps-band.nf{background:#8f8a95;background:color-mix(in srgb,var(--c1) 58%,#8a8a8a)}
    td.ps-perm{background:linear-gradient(120deg,var(--c1),var(--c2))!important;color:#fff!important;font-weight:900;font-size:15px}
    td.ps-perm small{display:block;font-weight:600;font-size:10px;opacity:.9;margin-top:2px}
    .ps-code{font-weight:800;letter-spacing:.3px;text-align:left!important}
    .ps-kr{color:#8a8390;font-weight:700}
    .ps-color{color:#5f5866}
    .ps-cai{font-weight:700;color:#3a3540}
    .ps-notes{padding:8px 24px 24px}
    .ps-note{display:flex;border:1px solid #ece7ef;border-radius:12px;overflow:hidden;margin-top:12px}
    .ps-note .lb{flex:0 0 96px;background:var(--soft);color:var(--c1);font-weight:800;font-size:13px;
      display:flex;align-items:center;justify-content:center;text-align:center;padding:10px}
    .ps-note ul{margin:0;padding:11px 16px 11px 30px;font-size:12.5px;color:#5f5866;line-height:1.75}
    .ps-note li{margin:1px 0}
    @media(max-width:560px){.ps-head .wm{font-size:24px}.ps-head .title{font-size:18px;letter-spacing:2px}.ps-head img{height:34px;width:34px}}
    `;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  // 依「防焰／不防焰」分組；組內依每米價由低到高排序
  function groupRows(rows, is3m) {
    const groups = [], order = {};
    rows.forEach(r => {
      const k = r.fireproof || '';
      if (!(k in order)) { order[k] = groups.length; groups.push({ fireproof: k, rows: [] }); }
      groups[order[k]].rows.push(r);
    });
    // 不防焰(空/不防焰) 在前、防焰在後
    groups.sort((a, b) => (a.fireproof === '防焰' ? 1 : 0) - (b.fireproof === '防焰' ? 1 : 0));
    groups.forEach(g => g.rows.sort((a, b) => priceOf(a, is3m) - priceOf(b, is3m)));
    return groups;
  }

  function rowCells(r, is3m, hasKr, customer) {
    const price = priceOf(r, is3m);
    const permCell = is3m
      ? `<td class="ps-perm">${nt(price)}<small>未稅</small></td>`
      : `<td class="ps-perm">${nt(price)}${customer ? '' : `<small>未稅 ${nt(r.per_m)}</small>`}</td>`;
    const krCol = hasKr ? `<td class="ps-code ps-kr">${esc(r.kr_code || '—')}</td>` : '';
    return `<td class="ps-code">${esc(r.asia_code || '—')}</td>${krCol}` +
      `<td>${r.roll_len || 50}</td>${permCell}` +
      `<td class="ps-cai">${nt(r.plane)}</td><td class="ps-cai">${nt(r.cabinet)}</td><td class="ps-cai">${nt(r.shape)}</td>`;
  }

  // 產生單一品牌的牌價表 HTML
  function renderSheet(brand, rows, opts) {
    injectCss();
    opts = opts || {};
    const b = BRANDS[brand]; if (!b) return '';
    const is3m = brand === '3m';
    // 濾掉沒有價格的空列（避免 $0 佔位列）
    rows = (rows || []).filter(r => (Number(r.per_m) || 0) > 0 || (Number(r.ecom_price) || 0) > 0);
    const hasKr = rows.some(r => (r.kr_code || '').trim());      // 有韓碼才顯示「韓國系列」欄
    const groups = groupRows(rows, is3m);
    const showBand = groups.length > 1 || (groups[0] && groups[0].fireproof);
    const cols = 6 + (hasKr ? 1 : 0) + (showBand ? 1 : 0);

    const codeTh = hasKr
      ? '<th style="width:20%">亞洲系列</th><th style="width:12%">韓國系列</th>'
      : '<th style="width:32%">系列／型號</th>';
    const head = `<tr>${showBand ? '<th style="width:3%"></th>' : ''}${codeTh}` +
      `<th style="width:8%">規格<br>(米)</th>` +
      `<th class="ps-ph" style="width:13%">${is3m ? '每才 $' : '每米 $'}</th>` +
      `<th style="width:15%">連工帶料<br>全平面牆面</th><th style="width:14%">系統櫃<br>門片</th><th style="width:15%">連工帶料<br>造型</th></tr>`;

    let bodyRows = '';
    groups.forEach(g => {
      g.rows.forEach((r, i) => {
        const band = (showBand && i === 0)
          ? `<td class="ps-band ${g.fireproof === '防焰' ? '' : 'nf'}" rowspan="${g.rows.length}">${esc(g.fireproof || '')}</td>` : '';
        bodyRows += `<tr>${band}${rowCells(r, is3m, hasKr, opts.customer)}</tr>`;
      });
    });
    const body = bodyRows || `<tr><td colspan="${cols}" style="padding:36px;color:#9ca3af">此品牌尚無牌價資料</td></tr>`;

    return `<div class="ps-sheet" style="--c1:${b.c1};--c2:${b.c2};--soft:${b.soft}" data-brand="${brand}">
      <div class="ps-head">
        <img src="/logo.png" alt="繪新">
        <div class="wm">${b.name}<small>${esc(b.sub)}</small></div>
        <div class="title">裝潢貼膜價格表</div>
        <div class="date">繪新國際<br>更新日 ${todayStr()}</div>
      </div>
      <div class="ps-scroll"><table class="ps-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      ${notesHtml(brand)}
    </div>`;
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
