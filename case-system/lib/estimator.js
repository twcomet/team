// 估價計價引擎 —— 忠實移植同事估價原型（繪新估價原型_互動版.html）的計價邏輯。
// 價目改讀 est_films / est_glass / est_doors / est_freight / settings（不再寫死），算法與原型逐行對齊。
// ⚠️ 現貨/期貨、未確定型號(品牌最高價)等新機制尚未加入，之後另行擴充（見 project-quote-integration-handover）。

// ── 共用基礎（與原型相同）─────────────────────────────────────────
const ceil100   = n => Math.ceil(n / 100) * 100;          // 金額無條件進位到百元
const roundWall = h => Math.round((+h + 10) / 10) * 10;    // 牆面高 +10cm 損耗後四捨五入到 10
const roundElev = h => Math.ceil((+h + 20) / 10) * 10;    // 電梯高 +20cm 損耗後無條件進位到 10

// 電梯每才單價：現貨價區間用固定值，否則造型價 +20
function elevUnit(f) {
  if (f.flatPrice) return f.shape;
  if (f.origin === 'kr') return (f.perM <= 1350) ? 220 : (f.shape + 20);
  return (f.perM <= 2400) ? 300 : (f.shape + 20);
}

const workName = { plane: '全平面', cabinet: '系統櫃門片', shape: '造型' };

// ── 從 DB 組出與原型相同形狀的價目（FILMS/GLASS/DOOR/FREIGHT/LOWMIN）──
function buildCatalog(db) {
  const films = db.prepare(`SELECT * FROM est_films ORDER BY sort_order, id`).all();
  const glass = db.prepare(`SELECT * FROM est_glass ORDER BY sort_order, id`).all();
  const doors = db.prepare(`SELECT * FROM est_doors ORDER BY sort_order, id`).all();
  const freight = db.prepare(`SELECT * FROM est_freight ORDER BY sort_order, id`).all();
  const lo = db.prepare(`SELECT key,value FROM settings WHERE key IN ('est_lowmin_owner','est_lowmin_designer')`).all();
  return buildCatalogFromRows({ films, glass, doors, freight, lo });
}

// 由原始列（DB 或測試注入）組出價目結構。idx 以列順序為準，與原型 items[] 對齊。
function buildCatalogFromRows({ films, glass, doors, freight, lo }) {
  const FILMS = {};
  films.forEach(r => {
    if (!FILMS[r.grp_key]) FILMS[r.grp_key] = { label: r.grp_label, origin: r.origin, width: r.width, flatPrice: !!r.flat_price, items: [] };
    FILMS[r.grp_key].items.push({ sys: r.sys, perM: r.per_m, plane: r.plane, cabinet: r.cabinet, shape: r.shape });
  });
  const GLASS = {};
  glass.forEach(r => {
    if (!GLASS[r.cat_key]) GLASS[r.cat_key] = { label: r.cat_label, items: [] };
    GLASS[r.cat_key].items.push({ sys: r.sys, owner: r.owner_price, designer: r.designer_price });
  });
  const DOOR = {};
  doors.forEach(r => {
    if (r.frame_only) {
      DOOR[r.door_key] = DOOR[r.door_key] || { label: r.label, frameOnly: 1 };
      DOOR[r.door_key][r.origin] = r.price;
    } else {
      DOOR[r.door_key] = DOOR[r.door_key] || { label: r.label };
      const d = DOOR[r.door_key];
      d[r.origin] = d[r.origin] || {};
      d[r.origin][r.layers] = d[r.origin][r.layers] || {};
      d[r.origin][r.layers][r.opt] = r.price;
    }
  });
  // 車馬費：同事原型只用單一值＝施工車馬費(amount)；保留其餘 3 欄供日後擴充
  const FREIGHT = {};
  freight.forEach(r => { FREIGHT[r.region] = r.amount || 0; });
  const lowmin = {
    owner: Number((lo.find(x => x.key === 'est_lowmin_owner') || {}).value || 10000),
    designer: Number((lo.find(x => x.key === 'est_lowmin_designer') || {}).value || 9000),
  };
  return { FILMS, GLASS, DOOR, FREIGHT, LOWMIN: lowmin };
}

// ── 牆面（裝潢貼膜）：同品牌+工法+系列併料 ───────────────────────────
function computeWalls(walls, FILMS) {
  const groups = {};
  walls.forEach((it, ci) => {
    const f = FILMS[it.brand], W = f.width, key = it.brand + '|' + it.idx + '|' + it.work;
    groups[key] = groups[key] || { f, W, idx: it.idx, work: it.work, full: 0, pieces: [], n: 0, idxs: [] };
    const g = groups[key]; g.n++; g.idxs.push(ci);
    const H = roundWall(it.h), full = Math.floor(it.w / W), rem = it.w - full * W;
    g.full += full * (H / 100);
    if (rem > 0) g.pieces.push({ h: H, w: rem, comb: (it.work === 'plane' && rem < (W - 2)) });
  });
  const lines = [];
  Object.keys(groups).forEach(k => {
    const g = groups[k], W = g.W, Fb = W * 100 / 900, item = g.f.items[g.idx];
    const pcs = g.pieces.slice().sort((a, b) => b.h - a.h), strips = [];
    pcs.forEach(pc => {
      let placed = false;
      if (pc.comb) {
        for (let i = 0; i < strips.length; i++) {
          const s = strips[i];
          if (s.used + pc.w <= W && pc.h <= s.host) { s.used += pc.w; s.mem++; placed = true; break; }
        }
      }
      if (!placed) strips.push({ used: pc.w, host: pc.h, mem: 1 });
    });
    const packM = strips.reduce((a, s) => a + s.host / 100, 0), m = g.full + packM, cai = m * Fb, unit = item[g.work], amt = ceil100(cai * unit);
    const comb = strips.filter(s => s.mem > 1).length;
    lines.push({ type: 'wall', work: g.work, label: g.f.label.split('（')[0] + '｜' + workName[g.work], series: item.sys, n: g.n, cai, unit, amount: amt, comb, idxs: g.idxs });
  });
  return lines;
}

// ── 玻璃：逐片算、不併料，單價分業主/設計師 ───────────────────────
function computeGlass(gl, GLASS, cust) {
  const groups = {};
  gl.forEach((it, ci) => {
    const item = GLASS[it.cat].items[it.idx], unit = cust === 'owner' ? item.owner : item.designer, key = it.cat + '|' + it.idx + '|' + unit;
    const cai = it.w * it.h / 900, amt = ceil100(cai * unit);
    groups[key] = groups[key] || { label: GLASS[it.cat].label, series: item.sys, unit, n: 0, amount: 0, idxs: [] };
    const g = groups[key]; g.n++; g.amount += amt; g.idxs.push(ci);
  });
  return Object.keys(groups).map(k => {
    const g = groups[k];
    return { type: 'glass', label: '玻璃｜' + g.label, series: g.series + '（' + g.unit + '/才）', n: g.n, amount: g.amount, idxs: g.idxs };
  });
}

// ── 電梯內箱 / 天花板：才數法，高 +20cm 損耗 ─────────────────────────
function elevBoxAmt(it, FILMS) {
  const f = FILMS[it.brand], W = f.width, Fb = W * 100 / 900, item = f.items[it.idx];
  const unit = elevUnit({ origin: f.origin, perM: item.perM, shape: item.shape, flatPrice: f.flatPrice }), H = roundElev(it.h);
  let m = 0;
  if (it.side) m += Math.ceil(it.side / W) * (H / 100);
  if (it.backw) m += Math.ceil(it.backw / W) * (H / 100);
  return ceil100(m * Fb * unit);
}
function elevCeilAmt(it, FILMS) {
  const f = FILMS[it.brand], W = f.width, Fb = W * 100 / 900, item = f.items[it.idx];
  const unit = elevUnit({ origin: f.origin, perM: item.perM, shape: item.shape, flatPrice: f.flatPrice }), ch = roundElev(it.cl);
  const m = Math.ceil(it.cw / W) * (ch / 100);
  return ceil100(m * Fb * unit);
}

// ── 彙整所有品項成報價列（電梯/門逐項合併同規格）＋整體折扣 ─────────
function buildLines(cart, catalog, opts) {
  const { FILMS, GLASS, DOOR } = catalog;
  const cust = opts.cust || 'owner';
  let lines = [];
  lines = lines.concat(computeWalls(cart.filter(c => c.kind === 'wall'), FILMS));
  lines = lines.concat(computeGlass(cart.filter(c => c.kind === 'glass'), GLASS, cust));
  const fixed = {};
  cart.forEach((it, ci) => {
    let sig, label, series, amt;
    if (it.kind === 'elev-box') { amt = elevBoxAmt(it, FILMS); sig = 'EB|' + it.brand + '|' + it.idx + '|' + it.side + '|' + it.backw + '|' + it.h; label = '電梯內箱'; series = FILMS[it.brand].items[it.idx].sys; }
    else if (it.kind === 'elev-ceil') { amt = elevCeilAmt(it, FILMS); sig = 'EC|' + it.brand + '|' + it.idx + '|' + it.cl + '|' + it.cw; label = '電梯天花板'; series = FILMS[it.brand].items[it.idx].sys; }
    else if (it.kind === 'elev-floor') { amt = it.ftype === 'one' ? 12000 : 8000; sig = 'EL|' + it.ftype; label = '電梯地板' + (it.ftype === 'one' ? '·一片式' : '·塑膠地磚'); series = '固定價'; }
    else if (it.kind === 'door') { const d = DOOR[it.dtype]; amt = d.frameOnly ? d[it.origin] : d[it.origin][it.sides][it.frame]; sig = 'D|' + it.dtype + '|' + it.origin + '|' + it.sides + '|' + it.frame; label = '門｜' + d.label; series = (it.origin === 'kr' ? '韓國' : '日本') + (d.frameOnly ? '' : ('·' + it.sides + '層·選項' + it.frame)); }
    else return;
    if (fixed[sig]) { fixed[sig].n++; fixed[sig].amount += amt; fixed[sig].idxs.push(ci); }
    else { fixed[sig] = { type: 'fixed', label, series, n: 1, amount: amt, idxs: [ci] }; lines.push(fixed[sig]); }
  });
  // 整體折扣（r<1 才打折；保留原價於 base）
  const r = parseFloat(opts.disc) || 1;
  if (r < 1) lines.forEach(L => { L.base = L.amount; L.amount = Math.round(L.amount * r); });
  return lines;
}

// ── 主入口：算出報價列＋金額彙總（低消、車馬費，順序與原型一致）─────
function quote(cart, opts, catalog) {
  opts = opts || {};
  const cust = opts.cust || 'owner';
  const region = opts.region || '';
  const lines = buildLines(cart, catalog, opts);

  const sub = lines.reduce((a, L) => a + (L.base || L.amount), 0);    // 原價小計
  const afterDisc = lines.reduce((a, L) => a + L.amount, 0);          // 折後小計
  const discAmt = sub - afterDisc;
  const lowmin = catalog.LOWMIN[cust];
  const lowApplied = afterDisc > 0 && afterDisc < lowmin;            // 折後不足低消才補
  const itemsFinal = lowApplied ? lowmin : afterDisc;
  const freight = catalog.FREIGHT[region] || 0;                      // 車馬費最後加、不算進低消
  const total = itemsFinal + freight;

  return { lines, cust, region, sub, afterDisc, discAmt, lowmin, lowApplied, itemsFinal, freight, total };
}

module.exports = {
  ceil100, roundWall, roundElev, elevUnit, workName,
  buildCatalog, buildCatalogFromRows,
  computeWalls, computeGlass, elevBoxAmt, elevCeilAmt, buildLines, quote,
};
