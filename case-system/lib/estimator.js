// 估價計價引擎（重設計版）—— 依繪新真實價目表：裝潢膜 品牌×防焰×膜款(三種連工帶料價別)、門三類。
// 算法：才＝寬×高÷900；金額進位百元；牆面(plane)自動併料；玻璃逐片；電梯/門固定價。價目讀 lib/estimator-catalog（之後改讀 est_*_catalog 表）。
const DEFAULT = require('./estimator-catalog');

const ceil100   = n => Math.ceil(n / 100) * 100;
const roundWall = h => Math.round((+h + 10) / 10) * 10;   // 牆面高 +10cm 損耗→四捨五入到 10
const roundElev = h => Math.ceil((+h + 20) / 10) * 10;   // 電梯高 +20cm 損耗→無條件進位到 10
const filmW = it => it.width || 122;                      // 膜寬，預設 122（PS 石膏 93）
const workName = { plane: '牆面', cabinet: '系統櫃', shape: '造型' };

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
function computeFilms(arr, cat) {
  const groups = {};
  arr.forEach((it, ci) => {
    const item = filmItem(cat, it.brand, it.idx), W = filmW(item), key = it.brand + '|' + it.idx + '|' + it.work;
    groups[key] = groups[key] || { item, brand: it.brand, W, work: it.work, full: 0, pieces: [], n: 0, idxs: [] };
    const g = groups[key]; g.n++; g.idxs.push(ci);
    const H = roundWall(it.h), full = Math.floor(it.w / W), rem = it.w - full * W;
    g.full += full * (H / 100);
    if (rem > 0) g.pieces.push({ h: H, w: rem, comb: (it.work === 'plane' && rem < (W - 2)) });
  });
  return Object.keys(groups).map(k => {
    const g = groups[k], W = g.W, Fb = W * 100 / 900, unit = g.item[g.work];
    const pcs = g.pieces.slice().sort((a, b) => b.h - a.h), strips = [];
    pcs.forEach(pc => {
      let placed = false;
      if (pc.comb) for (let i = 0; i < strips.length; i++) { const s = strips[i]; if (s.used + pc.w <= W && pc.h <= s.host) { s.used += pc.w; s.mem++; placed = true; break; } }
      if (!placed) strips.push({ used: pc.w, host: pc.h, mem: 1 });
    });
    const packM = strips.reduce((a, s) => a + s.host / 100, 0), m = g.full + packM, cai = m * Fb, amt = ceil100(cai * unit);
    const comb = strips.filter(s => s.mem > 1).length;
    return { type: 'film', work: g.work, brand: g.brand, label: workName[g.work] + '｜' + cat.FILMS[g.brand].label, series: g.item.asia + ' ' + g.item.color, n: g.n, cai, unit, amount: amt, comb, idxs: g.idxs };
  });
}
function computeGlass(arr, cat, cust) {
  const groups = {};
  arr.forEach((it, ci) => {
    const item = cat.GLASS[it.cat].items[it.idx], unit = cust === 'owner' ? item.owner : item.designer, key = it.cat + '|' + it.idx + '|' + unit;
    const cai = it.w * it.h / 900, amt = ceil100(cai * unit);
    groups[key] = groups[key] || { label: cat.GLASS[it.cat].label, series: item.sys, unit, n: 0, amount: 0, idxs: [] };
    const g = groups[key]; g.n++; g.amount += amt; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => { const g = groups[k]; return { type: 'glass', label: '玻璃｜' + g.label, series: g.series + '（' + g.unit + '/才）', n: g.n, amount: g.amount, idxs: g.idxs }; });
}
function computeOther(arr) {
  const groups = {};
  arr.forEach((it, ci) => {
    const cai = it.w * it.h / 900, amt = ceil100(cai * it.unit), key = it.name + '|' + it.w + '|' + it.h + '|' + it.unit;
    groups[key] = groups[key] || { label: '其他｜' + it.name, series: it.w + '×' + it.h + ' cm', cai, unit: it.unit, n: 0, amount: 0, idxs: [] };
    const g = groups[key]; g.n++; g.amount += amt; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => { const g = groups[k]; return { type: 'other', label: g.label, series: g.series, cai: g.cai, unit: g.unit, n: g.n, amount: g.amount, idxs: g.idxs }; });
}
function elevBoxAmt(c, cat) { const it = filmItem(cat, c.brand, c.idx), W = filmW(it), Fb = W * 100 / 900, unit = elevUnit(it), H = roundElev(c.h); let m = 0; if (c.side) m += Math.ceil(c.side / W) * (H / 100); if (c.backw) m += Math.ceil(c.backw / W) * (H / 100); return ceil100(m * Fb * unit); }
function elevCeilAmt(c, cat) { const it = filmItem(cat, c.brand, c.idx), W = filmW(it), Fb = W * 100 / 900, unit = elevUnit(it), ch = roundElev(c.cl), m = Math.ceil(c.cw / W) * (ch / 100); return ceil100(m * Fb * unit); }

function buildLines(cart, opts, cat) {
  const cust = opts.cust || 'owner';
  let lines = [];
  lines = lines.concat(computeFilms(cart.filter(c => c.kind === 'film'), cat));
  lines = lines.concat(computeGlass(cart.filter(c => c.kind === 'glass'), cat, cust));
  lines = lines.concat(computeOther(cart.filter(c => c.kind === 'other')));
  const fixed = {};
  cart.forEach((it, ci) => {
    let sig, label, series, amt, ftype = 'fixed';
    if (it.kind === 'elev-box') { amt = elevBoxAmt(it, cat); sig = 'EB|' + it.brand + '|' + it.idx + '|' + it.side + '|' + it.backw + '|' + it.h; label = '電梯內箱'; series = filmItem(cat, it.brand, it.idx).asia; }
    else if (it.kind === 'elev-ceil') { amt = elevCeilAmt(it, cat); sig = 'EC|' + it.brand + '|' + it.idx + '|' + it.cl + '|' + it.cw; label = '電梯天花板'; series = filmItem(cat, it.brand, it.idx).asia; }
    else if (it.kind === 'elev-floor') { amt = it.ftype === 'one' ? 12000 : 8000; sig = 'EL|' + it.ftype; label = '電梯地板' + (it.ftype === 'one' ? '·一片式' : '·塑膠地磚'); series = '固定價'; }
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

module.exports = {
  ceil100, roundWall, roundElev, filmW, elevUnit, doorPrice, workName,
  computeFilms, computeGlass, computeOther, elevBoxAmt, elevCeilAmt, buildLines, quote,
  catalog: DEFAULT,
};
