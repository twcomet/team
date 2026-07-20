/* 繪新膜料牌價表 —— 共用渲染引擎（估價牌價 est_film_catalog）
   版型參考公司實體「裝潢貼膜價格表」：品牌抬頭 + 防焰/不防焰側欄 + 每米價高亮 + 連工帶料三檔 + 底部說明。
   不顯示成本/毛利（老闆請看報價設定）。 */
(function () {
  const ORDER = ['paroi', 'benif', 'bodaq_asia', 'bodaq_kr', '3m', 'special'];
  const BRANDS = {
    paroi: { name: 'PAROI', sub: '日本 LINTEC', c1: '#6f5122', c2: '#b58a45', soft: '#f6efe2', freight: 'jp' },
    benif: { name: 'BENIF', sub: 'LX Hausys（LG）· 韓國', c1: '#41560f', c2: '#7f9d33', soft: '#eef3df', freight: 'kr' },
    bodaq_asia: { name: 'Bodaq 亞洲', sub: 'HYUNDAI · 亞洲版', c1: '#4a1178', c2: '#d4148a', soft: '#f7e6f4', freight: 'kr' },
    bodaq_kr:   { name: 'Bodaq 韓國', sub: 'HYUNDAI · 韓國版', c1: '#4a1178', c2: '#d4148a', soft: '#f7e6f4', freight: 'kr' },
    '3m': { name: '3M', sub: 'DI-NOC 特耐軟片', c1: '#9c0f22', c2: '#e11f33', soft: '#fbe7e9', freight: null },
    special: { name: '玻璃膜·隔熱·特殊膜', sub: '3M Fasara · CarLife 隔熱紙 · 穩得', c1: '#0e6b7a', c2: '#22a5c4', soft: '#e0f6fb', freight: null },
  };
  // special 類別的品牌中文名（依 est_film_catalog.brand）
  const SP_BRAND = { '3m': '3M', carlife: 'CarLife 隔熱紙', wonder: '穩得', special: '特殊膜' };
  // 判斷是否玻璃膜/隔熱/特殊膜（元/才計價，歸到 special 類別）
  const isSpecial = f => f.brand === 'carlife' || f.brand === 'wonder' || f.brand === 'special' ||
    (f.brand === '3m' && (/^SH2/.test(f.asia_code || '') || (f.asia_code || '') === 'WH-111'));
  const FREIGHT_NOTE = {
    kr: ['空運 $6,000／一款（約 2–10 工作天，不含假日）', '海運 $3,000／一款（約 20–30 工作天，不含假日）'],
    jp: ['空運 $6,000／一款（約 3–4 週，不含假日）'],
  };
  // 3M DI-NOC 官方牌價（2026/5/1）——建議售價「元/才」(未稅)、現貨供應色號、規格、才(支)。單一真實來源。
  const OFFICIAL_3M = [
    { code: 'AE', colors: 'AE-1643、AE-2154、AE-2160、AE-2161、AE-2503、AE-2508、AE-2509', w: 122, roll: 50, tsai: 656, price: 170 },
    { code: 'AE-MT', colors: 'AE-1917MT', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'AM', colors: 'AM-1696', w: 122, roll: 50, tsai: 656, price: 385 },
    { code: 'AR', label: 'AR 耐磨系列', colors: 'ME-2284AR、ME-2285AR、ME-2292AR、ME-2293AR、ME-2295AR、PS-055AR', w: 122, roll: 25, tsai: 328, price: 235 },
    { code: 'CA', colors: 'CA-420、CA-421', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'CH', colors: 'CH-1629、CH-1630、CH-1631、CH-2116、CH-2118', w: 122, roll: 50, tsai: 656, price: 160 },
    { code: 'CN', colors: 'CN-1622、CN-1623', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'DW-MT', colors: 'DW-1873MT、DW-1881MT、DW-1883MT、DW-2200MT、DW-2202MT、DW-2218MT、DW-2223MT', w: 122, roll: 50, tsai: 656, price: 205 },
    { code: 'ET', colors: '', w: 122, roll: 25, tsai: 328, price: 460 },
    { code: 'EX', label: 'EX 外牆系列', colors: 'FW-1805EX、ME-005EX、PS-959EX、WG-1143EX', w: 122, roll: 50, tsai: 656, price: 300 },
    { code: 'FA', colors: '', w: 122, roll: 50, tsai: 656, price: 220 },
    { code: 'FE', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'FW', colors: 'FW-236、FW-336、FW-337、FW-338、FW-1022、FW-1122、FW-1125、FW-1129、FW-1212、FW-1217、FW-1218、FW-1256、FW-1257、FW-1272、FW-1273、FW-1275、FW-1276、FW-1285、FW-1304、FW-1757、FW-1761、FW-1974、FW-1978、FW-1979、FW-7008、FW-7011', w: 122, roll: 50, tsai: 656, price: 155 },
    { code: 'HG', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'HS', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'LE', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'LW', colors: 'LW-1081', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'LZ', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'ME', colors: 'ME-147、ME-379、ME-380、ME-1225、ME-1434、ME-2024、ME-2027、ME-2172、ME-2173、ME-2273、ME-2274、ME-2275、ME-2554、ME-2558、ME-2564', w: 122, roll: 50, tsai: 656, price: 160 },
    { code: 'ME-MT', colors: '', w: 122, roll: 25, tsai: 328, price: 235 },
    { code: 'MW', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'NU', colors: 'NU-1240、NU-1786、NU-1789、NU-2008、NU-2010', w: 122, roll: 50, tsai: 656, price: 190 },
    { code: 'NU-MT', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PA', colors: 'PA-180、PA-181、PA-183、PA-185、PA-187、PA-320、PA-390', w: 122, roll: 50, tsai: 656, price: 155 },
    { code: 'PC', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PG', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PS', colors: 'PS-503、PS-504、PS-900、PS-1183', w: 122, roll: 50, tsai: 656, price: 140 },
    { code: 'PS-MT', colors: 'PS-3095MT、PS-3099MT、PS-3864MT、PS-3866MT', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PS-MTRC', colors: 'PS-2400MTRC、PS-2401MTRC、PS-2402MTRC、PS-2403MTRC、PS-2405MTRC', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PT', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'PW-MT', colors: '', w: 122, roll: 50, tsai: 656, price: 265 },
    { code: 'RS', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'RT', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'SE', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'SI', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'ST', colors: 'ST-1831、ST-2539', w: 122, roll: 50, tsai: 656, price: 215 },
    { code: 'ST-MT', colors: 'ST-1914MT、ST-1916MT、ST-2171MT', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'SU-MT', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'TE', colors: '', w: 122, roll: 50, tsai: 656, price: 235 },
    { code: 'VM', colors: 'VM-305、VM-1487、VM-1691、VM-1692、VM-2090、VM-2364、VM-2365、VM-2366', w: 122, roll: 25, tsai: 328, price: 375 },
    { code: 'VM-MT', colors: '', w: 122, roll: 25, tsai: 328, price: 460 },
    { code: 'WG', colors: 'WG-157、WG-247、WG-256、WG-453、WG-467、WG-664、WG-835、WG-836、WG-854、WG-865、WG-1044、WG-1046、WG-1067、WG-1140、WG-1141、WG-1196、WG-1708、WG-1837', w: 122, roll: 50, tsai: 656, price: 140 },
    { code: 'WH', label: '白板貼膜 WH-111', colors: 'WH-111', w: 125, roll: 30, tsai: 408, price: 205 },
  ];
  const NOTES_WORK = [
    '施工費以上報價皆未稅（連工帶料均為未稅），膜料寬度皆為 122 公分。',
    'PS 石膏膜寬為 93 公分（其餘皆 122 公分）。',
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
    td.ps-band{background:var(--c1);width:56px;padding:10px 6px;text-align:center;
      vertical-align:middle;border-bottom:2px solid #fff}
    td.ps-band.nf{background:#8f8a95;background:color-mix(in srgb,var(--c1) 72%,#8a8a8a)}
    .ps-band-t{writing-mode:vertical-rl;text-orientation:upright;color:#fff;font-weight:900;
      font-size:17px;letter-spacing:5px;display:inline-block}
    td.ps-perm{background-color:var(--c1)!important;background-image:linear-gradient(120deg,var(--c1),var(--c2))!important;color:#fff!important;font-weight:900;font-size:15px}
    table.ps-tbl tbody tr:hover td.ps-perm{background-color:var(--c1)!important;background-image:linear-gradient(120deg,var(--c1),var(--c2))!important;color:#fff!important}
    td.ps-perm small{display:block;font-weight:600;font-size:10px;opacity:.9;margin-top:2px}
    .ps-code{font-weight:800;letter-spacing:.3px;text-align:left!important}
    .ps-codes{text-align:left!important;font-size:11.5px;color:#5f5866;line-height:1.7;word-break:break-word;white-space:normal}
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
      : `<td class="ps-perm">${nt(price)}</td>`;   // 只顯示電商含稅每米，未稅隱藏（膜料只賣含稅價）
    const krCol = hasKr ? `<td class="ps-code ps-kr">${esc(r.kr_code || '—')}</td>` : '';
    const spec = `${Number(r.width) || 122}cm×${r.roll_len || 50}M`;   // 統一規格格式：寬cm×長M
    return `<td class="ps-code">${esc(r.asia_code || '—')}</td>${krCol}` +
      `<td>${spec}</td>${permCell}` +
      `<td class="ps-cai">${nt(r.plane)}</td><td class="ps-cai">${nt(r.cabinet)}</td><td class="ps-cai">${nt(r.shape)}</td>`;
  }

  // 標準品牌表格（PAROI/BENIF/BODAQ，每米價）
  function tableStd(brand, rows, opts) {
    rows = (rows || []).filter(r => (Number(r.per_m) || 0) > 0 || (Number(r.ecom_price) || 0) > 0);
    const hasKr = rows.some(r => (r.kr_code || '').trim());      // 有韓碼才顯示「韓國系列」欄
    const groups = groupRows(rows, false);
    const showBand = groups.length > 1 || (groups[0] && groups[0].fireproof);
    const cols = 6 + (hasKr ? 1 : 0) + (showBand ? 1 : 0);
    const bandTh = showBand ? '<th style="width:5%" rowspan="2"></th>' : '';
    const codeTh = hasKr
      ? '<th style="width:17%" rowspan="2">亞洲系列</th><th style="width:12%" rowspan="2">對應系列</th>'
      : '<th style="width:29%" rowspan="2">系列／型號</th>';
    const head =
      `<tr>${bandTh}${codeTh}` +
      `<th style="width:12%" rowspan="2">規格</th>` +
      `<th class="ps-ph" style="width:12%" rowspan="2">電商每米<br>(含稅)</th>` +
      `<th colspan="3" style="border-bottom:1px solid rgba(0,0,0,.14)">連工帶料（未稅・元／才）</th></tr>` +
      `<tr><th>全平面牆</th><th>系統櫃門片</th><th>造型</th></tr>`;
    let bodyRows = '';
    groups.forEach(g => {
      g.rows.forEach((r, i) => {
        const band = (showBand && i === 0)
          ? `<td class="ps-band ${g.fireproof === '防焰' ? '' : 'nf'}" rowspan="${g.rows.length}"><span class="ps-band-t">${esc(g.fireproof || '')}</span></td>` : '';
        bodyRows += `<tr>${band}${rowCells(r, false, hasKr, opts.customer)}</tr>`;
      });
    });
    const body = bodyRows || `<tr><td colspan="${cols}" style="padding:36px;color:#9ca3af">此品牌尚無牌價資料</td></tr>`;
    return `<table class="ps-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // 3M 表格（依 3M 官方牌價表：系列/現貨供應色號/規格/才(支)/每才建議售價；連工帶料取報價設定或公式回推）
  function table3m(dbRows) {
    const dbMap = {}; (dbRows || []).forEach(r => { dbMap[(r.asia_code || '').trim()] = r; });
    const head = `<tr>
      <th style="width:9%">系列</th><th style="width:37%">現貨供應色號</th>
      <th style="width:11%">規格</th><th style="width:7%">才(支)</th>
      <th class="ps-ph" style="width:11%">每才 $</th>
      <th style="width:8%">連工帶料<br>全平面牆面</th><th style="width:9%">系統櫃<br>門片</th><th style="width:8%">連工帶料<br>造型</th></tr>`;
    const body = OFFICIAL_3M.map(o => {
      const db = dbMap[o.code] || {};
      const plane = db.plane || o.price + 90, cabinet = db.cabinet || o.price + 120, shape = db.shape || o.price + 145;
      return `<tr>
        <td class="ps-code">${esc(o.label || o.code)}</td>
        <td class="ps-codes">${esc(o.colors || '—')}</td>
        <td>${o.w}cm×${o.roll}M</td>
        <td>${o.tsai}</td>
        <td class="ps-perm">${nt(o.price)}<small>未稅/才</small></td>
        <td class="ps-cai">${nt(plane)}</td><td class="ps-cai">${nt(cabinet)}</td><td class="ps-cai">${nt(shape)}</td>
      </tr>`;
    }).join('');
    return `<table class="ps-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // 玻璃膜·隔熱·特殊膜表格（元/才計價，無防焰、無每米；依品牌分組）
  function tableSpecial(rows) {
    const order = ['3m', 'carlife', 'wonder', 'special'], groups = {};
    (rows || []).forEach(r => { (groups[r.brand] = groups[r.brand] || []).push(r); });
    const head = `<tr><th style="width:14%">品牌</th><th style="width:44%">型號／花色</th>` +
      `<th style="width:20%">規格</th><th class="ps-ph" style="width:22%">連工帶料<br>(元／才・未稅)</th></tr>`;
    let body = '';
    order.forEach(bk => {
      const rs = groups[bk]; if (!rs || !rs.length) return;
      rs.forEach((r, i) => {
        const band = i === 0
          ? `<td class="ps-band nf" rowspan="${rs.length}"><span class="ps-band-t">${esc(SP_BRAND[bk] || bk)}</span></td>` : '';
        body += `<tr>${band}` +
          `<td class="ps-code" style="text-align:left">${esc(r.asia_code || '—')}${r.color ? ` <small style="color:#9ca3af">${esc(r.color)}</small>` : ''}${r.model_note ? `<br><small style="color:#9ca3af;font-weight:400">供應商：${esc(r.model_note)}</small>` : ''}</td>` +
          `<td>${r.width || 122}cm×${r.roll_len || 30}M</td>` +
          `<td class="ps-perm">${nt(r.plane)}</td></tr>`;
      });
    });
    if (!body) body = `<tr><td colspan="4" style="padding:36px;color:#9ca3af">尚無資料</td></tr>`;
    return `<table class="ps-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // 產生單一品牌的牌價表 HTML
  function renderSheet(brand, rows, opts) {
    injectCss();
    opts = opts || {};
    const b = BRANDS[brand]; if (!b) return '';
    const tableHtml = (brand === '3m') ? table3m(rows) : (brand === 'special') ? tableSpecial(rows) : tableStd(brand, rows, opts);
    return `<div class="ps-sheet" style="--c1:${b.c1};--c2:${b.c2};--soft:${b.soft}" data-brand="${brand}">
      <div class="ps-head">
        <img src="/logo.png" alt="繪新">
        <div class="wm">${b.name}<small>${esc(b.sub)}</small></div>
        <div class="title">裝潢貼膜價格表</div>
        <div class="date">繪新國際<br>更新日 ${todayStr()}</div>
      </div>
      <div class="ps-scroll">${tableHtml}</div>
      ${notesHtml(brand)}
    </div>`;
  }

  const NOTES_3M = [
    '建議售價為「元／才」未稅，比照 3M 官方牌價表（2026/5/1）。',
    '現貨供應最低出貨 32 才；規格 122cm×50M（部分系列 25M、WH 白板膜 125cm×30M）。',
    '底漆 WP-2000 $6,500／瓶（3.75L）、助黏劑 UPUV $2,150／瓶（946ml），依施工需求另計。',
    'Fasara 玻璃裝飾貼膜（SH2 系列）屬玻璃膜，另列報價。',
  ];
  function notesHtml(brand) {
    const f = BRANDS[brand].freight;
    const blk = (lb, arr) => `<div class="ps-note"><div class="lb">${lb}</div><ul>${arr.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
    if (brand === '3m') {
      return `<div class="ps-notes">
        ${blk('低消說明', LOWMIN_NOTE)}
        ${blk('3M 說明', NOTES_3M)}
        ${blk('施工費<br>說明', NOTES_WORK)}
      </div>`;
    }
    const freight = f ? FREIGHT_NOTE[f] : [];
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
    (d.films || []).forEach(f => {
      if (isSpecial(f)) { byBrand.special.push(f); return; }   // 玻璃膜/隔熱/特殊膜 → special 分頁
      if (f.brand === 'bodaq') {                               // Bodaq 依 region 拆成 亞洲／韓國 兩張表
        (String(f.region || '').includes('韓國') ? byBrand.bodaq_kr : byBrand.bodaq_asia).push(f);
        return;
      }
      if (byBrand[f.brand]) byBrand[f.brand].push(f);
    });
    return byBrand;
  }

  window.PriceSheet = { ORDER, BRANDS, renderSheet, fetchData };
})();
