// 估價計價引擎（重設計版）—— 依繪新真實價目表：裝潢膜 品牌×防焰×膜款(三種連工帶料價別)、門三類。
// 算法：才＝寬×高÷900；金額進位百元；牆面(plane)自動併料；玻璃逐片；電梯/門固定價。價目讀 lib/estimator-catalog（之後改讀 est_*_catalog 表）。
const DEFAULT = require('./estimator-catalog');

const ceil100   = n => Math.ceil(n / 100) * 100;
const roundWall = h => Math.round((+h + 10) / 10) * 10;   // 牆面高 +10cm 損耗→四捨五入到 10
const roundElev = h => Math.ceil((+h + 20) / 10) * 10;   // 電梯高 +20cm 損耗→無條件進位到 10
const filmW = it => it.width || 122;                      // 膜寬，預設 122（PS 石膏 93）
const workName = { plane: '牆面', cabinet: '系統櫃', shape: '造型', ceiling: '天花板' };
// 天花板每才單價 = 造型(shape) + 20；其餘工法直接讀該欄價
function workUnit(it, work) { return work === 'ceiling' ? (Number(it.shape) || 0) + 20 : it[work]; }

function filmItem(cat, brand, idx) { return cat.FILMS[brand].items[idx]; }
// 電梯每才單價：用該膜款「造型(shape)」連工帶料價（防焰不分後，無每米區間可判，取造型價為基準）
function elevUnit(it) { return it.shape; }
// 門固定價查表（伺服器權威，不信前端傳來的 price）
function doorPrice(cat, it) {
  if (it.cat === 'fire') return cat.DOORS.fire[it.size][it.origin][it.side];
  return cat.DOORS[it.cat][it.origin][it.side][it.frame];
}
function futMethod(cat, origin, v) {
  const ms = cat.FUT[origin].methods;
  return ms.filter(m => m.v === v)[0] || ms[0];
}

// ── 裝潢膜：同品牌+防焰+膜款+貼法 併料（plane 才併）────────────────
function _sizeStr(sizes) { return Object.keys(sizes).map(s => sizes[s] > 1 ? s + '×' + sizes[s] : s).join('、'); }
function _combCai(g) { // 拼料：g.full(整條米) + 畸零拼條 → 才
  const W = g.W, Fb = W * 100 / 900, pcs = g.pieces.slice().sort((a, b) => b.h - a.h), strips = [];
  pcs.forEach(pc => { let placed = false; if (pc.comb) for (let i = 0; i < strips.length; i++) { const s = strips[i]; if (s.used + pc.w <= W && pc.h <= s.host) { s.used += pc.w; s.mem++; placed = true; break; } } if (!placed) strips.push({ used: pc.w, host: pc.h, mem: 1 }); });
  return { cai: (g.full + strips.reduce((a, s) => a + s.host / 100, 0)) * Fb, comb: strips.filter(s => s.mem > 1).length };
}
// 牆面/系統櫃/造型：combine=true 時 牆面/系統櫃 拼料省料；其餘(含造型、寬鬆)＝膜寬×高(每片整條膜寬·多報)
function computeFilms(arr, cat, combine) {
  const groups = {};
  arr.forEach((it, ci) => {
    const item = filmItem(cat, it.brand, it.idx), W = filmW(item);
    const isComb = combine && (it.work === 'plane' || it.work === 'cabinet');
    const nm = (it.name || '').trim();
    // 與前端一致：依「項目名稱＋膜＋工法」分組（同一物件的多尺寸歸在一起）
    const key = nm + '|' + it.brand + '|' + it.idx + '|' + it.work + '|' + (isComb ? 'C' : 'L');
    groups[key] = groups[key] || { name: nm, item, brand: it.brand, W, work: it.work, isComb, full: 0, pieces: [], looseCai: 0, n: 0, idxs: [], sizes: {} };
    const g = groups[key]; g.n++; g.idxs.push(ci);
    g.sizes['寬' + it.w + '×高' + it.h] = (g.sizes['寬' + it.w + '×高' + it.h] || 0) + 1;
    if (isComb) {
      const H = roundWall(it.h), full = Math.floor(it.w / W), rem = it.w - full * W;
      g.full += full * (H / 100);
      if (rem > 0) g.pieces.push({ h: H, w: rem, comb: rem < (W - 2) });
    } else { g.looseCai += Math.ceil(it.w / W) * W * roundWall(it.h) / 900; } // 寬鬆：需要幾條×膜寬×(高+10cm損耗)（每條整條膜寬·多報）
  });
  return Object.keys(groups).map(k => {
    const g = groups[k], unit = workUnit(g.item, g.work);
    const r = g.isComb ? _combCai(g) : { cai: g.looseCai, comb: 0 };
    const title = (g.name ? g.name + '｜' : '') + workName[g.work] + '｜' + cat.FILMS[g.brand].label;
    return { type: 'film', work: g.work, brand: g.brand, label: title, series: g.item.asia + ' ' + g.item.color + '　' + _sizeStr(g.sizes), n: g.n, cai: r.cai, unit, amount: ceil100(r.cai * unit), comb: r.comb, idxs: g.idxs };
  });
}
// 玻璃：combine=true 拼料省料(用該玻璃膜寬)；否則 寬鬆＝膜寬×高
function computeGlass(arr, cat, cust, combine) {
  const groups = {};
  arr.forEach((it, ci) => {
    const item = cat.GLASS[it.cat].items[it.idx], unit = cust === 'owner' ? item.owner : item.designer, W = item.width || 122;
    const key = combine ? (it.cat + '|' + it.idx + '|' + unit) : (it.cat + '|' + it.idx + '|' + unit + '|' + it.h + '|' + it.w);
    groups[key] = groups[key] || { catLabel: cat.GLASS[it.cat].label, sys: item.sys, unit, W, isComb: !!combine, full: 0, pieces: [], looseCai: 0, n: 0, idxs: [], sizes: {} };
    const g = groups[key]; g.n++; g.idxs.push(ci);
    g.sizes['寬' + it.w + '×高' + it.h] = (g.sizes['寬' + it.w + '×高' + it.h] || 0) + 1;
    if (combine) {
      const H = roundWall(it.h), full = Math.floor(it.w / W), rem = it.w - full * W;
      g.full += full * (H / 100);
      if (rem > 0) g.pieces.push({ h: H, w: rem, comb: rem < (W - 2) });
    } else { g.looseCai += Math.ceil(it.w / W) * W * it.h / 900; } // 寬鬆：需要幾條×膜寬×高
  });
  return Object.keys(groups).map(k => {
    const g = groups[k];
    const r = g.isComb ? _combCai(g) : { cai: g.looseCai };
    return { type: 'glass', label: '玻璃｜' + g.catLabel, series: g.sys + '　' + _sizeStr(g.sizes) + '（' + g.unit + '/才）', n: g.n, cai: r.cai, unit: g.unit, amount: ceil100(r.cai * g.unit), idxs: g.idxs };
  });
}
// 其他品項：計價用「含損耗才數」＝寬+10、高+10，並套膜寬122拼料(省料)/寬鬆(多報)；caiM 可手動覆寫。並帶出圖片/尺寸/膜料供客戶頁
function computeOther(arr, cat, combine) {
  const groups = {};
  arr.forEach((it, ci) => {
    const fi = (it.mBrand && cat.FILMS[it.mBrand] && cat.FILMS[it.mBrand].items[it.mIdx || 0]) ? cat.FILMS[it.mBrand].items[it.mIdx || 0] : null;
    const W = (it.mw != null && Number(it.mw) > 0) ? Number(it.mw) : (fi ? filmW(fi) : 122);   // 料號膜寬優先(玻璃膜150)
    const wL = (Number(it.w) || 0) + 10, hL = (Number(it.h) || 0) + 10;   // 含損耗：寬+10、高+10
    const matLabel = fi ? ((cat.FILMS[it.mBrand].label || it.mBrand) + '｜' + fi.asia + ' ' + fi.color) : '';
    const key = it.name + '|' + it.w + '|' + it.h + '|' + it.unit + '|' + (it.caiM == null ? '' : it.caiM) + '|' + (it.mBrand || '') + '|' + (it.mIdx == null ? '' : it.mIdx) + '|' + (it.mWork || '') + '|' + W + '|' + (combine ? 'C' : 'L');
    groups[key] = groups[key] || { label: '其他｜' + it.name, series: '寬' + it.w + '×高' + it.h + ' cm', w: it.w, h: it.h, material: matLabel, photo: '', W, caiM: (it.caiM == null ? null : Number(it.caiM)), unit: it.unit, full: 0, pieces: [], looseCai: 0, n: 0, idxs: [] };
    const g = groups[key];
    if (it.photo && !g.photo) g.photo = it.photo;
    if (combine) { const full = Math.floor(wL / W), rem = wL - full * W; g.full += full * (hL / 100); if (rem > 0) g.pieces.push({ h: hL, w: rem, comb: rem < (W - 2) }); }
    else { g.looseCai += Math.ceil(wL / W) * W * hL / 900; }
    g.n++; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => {
    const g = groups[k];
    const r = combine ? _combCai(g) : { cai: g.looseCai };
    const lossGroup = r.cai, lossEach = Math.ceil(g.n ? lossGroup / g.n : lossGroup);   // 每件含損耗才數無條件進位到整數才
    const priceEach = (g.caiM != null) ? g.caiM : lossEach;
    const amount = ceil100(priceEach * g.unit) * g.n;
    return { type: 'other', label: g.label, series: g.series, material: g.material, w: g.w, h: g.h, photo: g.photo, cai: priceEach, unit: g.unit, n: g.n, amount, idxs: g.idxs };
  });
}
// 物件（籠統項目）：項目名稱＋單價＋數量；金額＝單價×數量（無才數）
function computeObject(arr) {
  const groups = {};
  arr.forEach((it, ci) => {
    const price = Number(it.price) || 0, key = it.name + '|' + price;
    groups[key] = groups[key] || { label: '物件｜' + it.name, series: '單價 $' + price.toLocaleString(), unit: price, n: 0, amount: 0, idxs: [] };
    const g = groups[key]; g.n++; g.amount += price; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => { const g = groups[k]; return { type: 'object', label: g.label, series: g.series, n: g.n, amount: g.amount, idxs: g.idxs }; });
}
// 其他特殊品項：米數＝米×條；材(才)數＝米數×單才(才/米)；金額＝材數×連工帶料(元/才)→進位百元
function computeSpecial(arr) {
  const groups = {};
  arr.forEach((it, ci) => {
    const meters = (Number(it.m) || 0) * (Number(it.strips) || 0);
    const cai = meters * (Number(it.per) || 0);
    const amt = ceil100(cai * (Number(it.unit) || 0));
    const key = it.name + '|' + it.m + '|' + it.strips + '|' + it.per + '|' + it.unit;
    groups[key] = groups[key] || { label: '其他特殊｜' + (it.name || '特殊品項'), series: it.m + '米 × ' + it.strips + '條 = ' + (Math.round(meters * 100) / 100) + '米　' + it.per + ' 才/米', cai, unit: it.unit, n: 0, amount: 0, idxs: [] };
    const g = groups[key]; g.n++; g.amount += amt; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => { const g = groups[k]; return { type: 'special', label: g.label, series: g.series, cai: g.cai, unit: g.unit, n: g.n, amount: g.amount, idxs: g.idxs }; });
}
function elevBoxAmt(c, cat) { const it = filmItem(cat, c.brand, c.idx), W = filmW(it), Fb = W * 100 / 900, unit = elevUnit(it), H = roundElev(c.h); let m = 0; if (c.side) m += Math.ceil(c.side / W) * (H / 100); if (c.backw) m += Math.ceil(c.backw / W) * (H / 100); return ceil100(m * Fb * unit); }
function elevCeilAmt(c, cat) { const it = filmItem(cat, c.brand, c.idx), W = filmW(it), Fb = W * 100 / 900, unit = elevUnit(it), ch = roundElev(c.cl), m = Math.ceil(c.cw / W) * (ch / 100); return ceil100(m * Fb * unit); }
// 電梯門（內門/內門框/外門/外門框）：算才數同內箱，單片＝⌈門寬/膜寬⌉×高(米)×Fb×造型價
const ELEV_DOOR_LABEL = { 'door-in': '內門', 'frame-in': '內門框', 'door-out': '外門', 'frame-out': '外門框' };
function elevDoorAmt(c, cat) { const it = filmItem(cat, c.brand, c.idx), W = filmW(it), Fb = W * 100 / 900, unit = elevUnit(it), H = roundElev(c.h), m = Math.ceil(c.w / W) * (H / 100); return ceil100(m * Fb * unit); }

function buildLines(cart, opts, cat) {
  const cust = opts.cust || 'owner';
  let lines = [];
  const combine = !!opts.combine; // 預設 false＝寬鬆(膜寬×高)；true＝拼料省料
  lines = lines.concat(computeFilms(cart.filter(c => c.kind === 'film'), cat, combine));
  lines = lines.concat(computeGlass(cart.filter(c => c.kind === 'glass'), cat, cust, combine));
  lines = lines.concat(computeOther(cart.filter(c => c.kind === 'other'), cat, combine));
  lines = lines.concat(computeObject(cart.filter(c => c.kind === 'object')));
  lines = lines.concat(computeSpecial(cart.filter(c => c.kind === 'special')));
  const fixed = {};
  cart.forEach((it, ci) => {
    let sig, label, series, amt, ftype = 'fixed';
    if (it.kind === 'elev-box') { amt = elevBoxAmt(it, cat); sig = 'EB|' + it.brand + '|' + it.idx + '|' + it.side + '|' + it.backw + '|' + it.h; label = '電梯內箱'; series = filmItem(cat, it.brand, it.idx).asia; }
    else if (it.kind === 'elev-ceil') { amt = elevCeilAmt(it, cat); sig = 'EC|' + it.brand + '|' + it.idx + '|' + it.cl + '|' + it.cw; label = '電梯天花板'; series = filmItem(cat, it.brand, it.idx).asia; }
    else if (it.kind === 'elev-floor') { amt = it.ftype === 'one' ? 12000 : 8000; sig = 'EL|' + it.ftype; label = '電梯地板' + (it.ftype === 'one' ? '·一片式' : '·塑膠地磚'); series = '固定價'; }
    else if (it.kind === 'elev-door') { amt = elevDoorAmt(it, cat); sig = 'ED|' + it.dpart + '|' + it.brand + '|' + it.idx + '|' + it.w + '|' + it.h; label = '電梯' + (ELEV_DOOR_LABEL[it.dpart] || '門'); series = filmItem(cat, it.brand, it.idx).asia + '　門寬' + it.w + '×門高' + it.h; }
    else if (it.kind === 'door') { amt = doorPrice(cat, it); const dl = cat.DOORS[it.cat].label, sideTxt = it.side === 'single' ? '單面' : '雙面', frameTxt = it.cat === 'fire' ? '含框' : (it.frame === 'yes' ? '含框' : '不含框'), szTxt = it.cat === 'fire' ? ('·' + cat.DOORS.fire[it.size].label) : ''; sig = 'D|' + it.cat + '|' + it.origin + '|' + it.side + '|' + it.size + '|' + it.frame; label = '門｜' + dl; series = (it.origin === 'kr' ? '韓國膜' : '日本膜') + szTxt + '·' + sideTxt + '·' + frameTxt; }
    else if (it.kind === 'fut') { const fm = futMethod(cat, it.origin, it.method); amt = fm.price; sig = 'FUT|' + it.origin + '|' + it.method; label = '期貨運費｜' + cat.FUT[it.origin].label + '·' + fm.name; series = '出貨 ' + fm.lead; ftype = 'fut'; }
    else return;
    if (fixed[sig]) { fixed[sig].n++; fixed[sig].amount += amt; fixed[sig].idxs.push(ci); }
    else { fixed[sig] = { type: ftype, label, series, n: 1, amount: amt, idxs: [ci] }; lines.push(fixed[sig]); }
  });
  // 整體折扣（期貨運費不打折）
  const r = parseFloat(opts.disc) || 1;
  if (r < 1) lines.forEach(L => { if (L.type === 'fut') return; L.base = L.amount; L.amount = Math.round(L.amount * r); });
  return lines;
}

// ── 主入口：算報價列＋金額彙總（低消、車馬費、期貨運費）─────────────
function quote(cart, opts, catalog) {
  opts = opts || {}; const cat = catalog || DEFAULT;
  const cust = opts.cust || 'owner', region = opts.region || '';
  const lines = buildLines(cart, opts, cat);
  const priced = lines.filter(L => L.type !== 'fut'), futLines = lines.filter(L => L.type === 'fut');
  const sub = priced.reduce((a, L) => a + (L.base || L.amount), 0);       // 原價小計（連工帶料）
  const afterDisc = priced.reduce((a, L) => a + L.amount, 0);             // 折後小計
  const discAmt = sub - afterDisc;
  const lowmin = cat.LOWMIN[cust];
  const lowApplied = afterDisc > 0 && afterDisc < lowmin;               // 折後不足低消才補（不含運費）
  const itemsFinal = lowApplied ? lowmin : afterDisc;
  const freight = cat.FREIGHT[region] || 0;                             // 車馬費(施工)，最後加、不計低消
  const fut = futLines.reduce((a, L) => a + L.amount, 0);               // 期貨運費，獨立加、不打折不計低消
  const total = itemsFinal + freight + fut;
  return { lines, cust, region, sub, afterDisc, discAmt, lowmin, lowApplied, itemsFinal, freight, fut, total };
}

// 從 DB 組出計價用的價目（讓「報價設定」的修改即時生效）。
// 順序用 sort_order,id（與 GET /catalog 一致）→ 膜款 idx 對齊；含未啟用列(active=0仍佔位)，避免 idx 位移。
function buildCatalogFromDb(db) {
  const FILMS = {};
  db.prepare(`SELECT * FROM est_film_catalog ORDER BY sort_order, id`).all().forEach(r => {
    if (!FILMS[r.brand]) FILMS[r.brand] = { label: (DEFAULT.FILMS[r.brand] || {}).label || r.brand, items: [] };
    FILMS[r.brand].items.push({ asia: r.asia_code, kr: r.kr_code, color: r.color, model: r.model_note, plane: r.plane, cabinet: r.cabinet, shape: r.shape, width: r.width });
  });
  const DOORS = {};
  db.prepare(`SELECT * FROM est_door_catalog ORDER BY sort_order, id`).all().forEach(r => {
    DOORS[r.cat] = DOORS[r.cat] || { label: (DEFAULT.DOORS[r.cat] || {}).label || r.cat };
    if (r.cat === 'fire') {
      DOORS.fire.sized = 1;
      DOORS.fire[r.size] = DOORS.fire[r.size] || { label: ((DEFAULT.DOORS.fire || {})[r.size] || {}).label || r.size };
      DOORS.fire[r.size][r.origin] = DOORS.fire[r.size][r.origin] || {};
      DOORS.fire[r.size][r.origin][r.side] = r.price;
    } else {
      DOORS[r.cat][r.origin] = DOORS[r.cat][r.origin] || {};
      DOORS[r.cat][r.origin][r.side] = DOORS[r.cat][r.origin][r.side] || {};
      DOORS[r.cat][r.origin][r.side][r.frame] = r.price;
    }
  });
  const GLASS = {};
  db.prepare(`SELECT * FROM est_glass ORDER BY sort_order, id`).all().forEach(r => {
    if (!GLASS[r.cat_key]) GLASS[r.cat_key] = { label: r.cat_label, items: [] };
    GLASS[r.cat_key].items.push({ sys: r.sys, owner: r.owner_price, designer: r.designer_price, width: r.width || 122 });
  });
  const FREIGHT = {};
  db.prepare(`SELECT region, amount FROM est_freight`).all().forEach(r => { FREIGHT[r.region] = r.amount || 0; });
  const lo = db.prepare(`SELECT key,value FROM settings WHERE key IN ('est_lowmin_owner','est_lowmin_designer')`).all();
  const LOWMIN = {
    owner: Number((lo.find(x => x.key === 'est_lowmin_owner') || {}).value || 10000),
    designer: Number((lo.find(x => x.key === 'est_lowmin_designer') || {}).value || 10000),
  };
  return { FILMS, GLASS, DOORS, FREIGHT, LOWMIN, FUT: DEFAULT.FUT };
}

module.exports = {
  ceil100, roundWall, roundElev, filmW, elevUnit, doorPrice, workName,
  computeFilms, computeGlass, computeOther, computeSpecial, elevBoxAmt, elevCeilAmt, buildLines, quote,
  buildCatalogFromDb, catalog: DEFAULT,
};
