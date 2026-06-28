// 計價引擎對拍測試：lib/estimator.js 是否與同事原型(繪新估價原型_互動版.html)算出一致。
// 三道驗證：①手算絕對值錨點 ②buildCatalogFromRows(模擬 DB seed) ③原型函式逐項對拍。
// 不符即 exit 1。執行：node scripts/estimator-check.js
const seed = require('../lib/estimator-seed');
const eng = require('../lib/estimator');

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { console.error(`✗ ${msg}\n   got = ${JSON.stringify(got)}\n   want= ${JSON.stringify(want)}`); fails++; }
  else console.log(`✓ ${msg}`);
};

// ── 由 seed 攤平成 DB 列，餵 buildCatalogFromRows（同時驗證 DB loader 路徑）──
function rowsFromSeed() {
  const films = [], glass = [], doors = [], freight = [];
  let so = 0;
  for (const [gk, g] of Object.entries(seed.FILMS))
    g.items.forEach(it => films.push({ grp_key: gk, grp_label: g.label, origin: g.origin, width: g.width, flat_price: g.flatPrice ? 1 : 0, sys: it.sys, per_m: it.perM, plane: it.plane, cabinet: it.cabinet, shape: it.shape, sort_order: so++ }));
  so = 0;
  for (const [ck, c] of Object.entries(seed.GLASS))
    c.items.forEach(it => glass.push({ cat_key: ck, cat_label: c.label, sys: it.sys, owner_price: it.owner, designer_price: it.designer, sort_order: so++ }));
  so = 0;
  for (const [dk, d] of Object.entries(seed.DOOR)) {
    if (d.frameOnly) { doors.push({ door_key: dk, label: d.label, frame_only: 1, origin: 'kr', layers: null, opt: null, price: d.kr, sort_order: so++ }); doors.push({ door_key: dk, label: d.label, frame_only: 1, origin: 'jp', layers: null, opt: null, price: d.jp, sort_order: so++ }); }
    else for (const origin of ['kr', 'jp']) for (const layers of ['1', '2']) for (const opt of [0, 1]) doors.push({ door_key: dk, label: d.label, frame_only: 0, origin, layers, opt, price: d[origin][layers][opt], sort_order: so++ });
  }
  so = 0;
  for (const [region, f] of Object.entries(seed.FREIGHT)) freight.push({ region, amount: f.amount, survey_fee: f.survey_fee, overnight_fee: f.overnight_fee, night_surcharge: f.night_surcharge, sort_order: so++ });
  const lo = [{ key: 'est_lowmin_owner', value: '10000' }, { key: 'est_lowmin_designer', value: '9000' }];
  return { films, glass, doors, freight, lo };
}
const catalog = eng.buildCatalogFromRows(rowsFromSeed());

// 驗證 catalog 結構與 seed 等值（idx 對齊很關鍵）
eq(catalog.FILMS.krmerge.items[1], seed.FILMS.krmerge.items[1], 'catalog FILMS idx 對齊 seed');
eq(catalog.DOOR.main.kr['1'][0], 10000, 'catalog DOOR main/kr/1層/選項0 = 10000');
eq(catalog.DOOR['frame-12'].kr, 8000, 'catalog DOOR frame-12/kr = 8000');
eq(catalog.FREIGHT['雲嘉投'], 6000, 'catalog FREIGHT 雲嘉投 = 施工車馬費 6000');
eq(catalog.LOWMIN, { owner: 10000, designer: 9000 }, 'catalog LOWMIN');

// ── ① 手算絕對值錨點 ────────────────────────────────────────────────
// 牆面 krmerge idx1(plane130) 122寬, h240 w300 → cai 7.5*13.5556=101.667 ×130 → ceil100=13300
eq(eng.quote([{ kind: 'wall', brand: 'krmerge', idx: 1, work: 'plane', h: 240, w: 300 }], { cust: 'designer', region: '北北桃' }, catalog).afterDisc, 13300, '手算①牆面單片=13300');
// 玻璃 fog owner120, h200 w100 → cai 22.222 ×120=2666.7 → ceil100=2700（未達低消補到10000）
{ const r = eng.quote([{ kind: 'glass', cat: 'fog', idx: 0, h: 200, w: 100 }], { cust: 'owner', region: '北北桃' }, catalog);
  eq(r.afterDisc, 2700, '手算②玻璃=2700'); eq(r.lowApplied, true, '手算②未達低消'); eq(r.itemsFinal, 10000, '手算②補到低消10000'); eq(r.total, 10000, '手算②總價(北北桃車馬0)'); }
// 門 main/kr/1層/選項0=10000 + 車馬費雲嘉投6000 → total 16000
eq(eng.quote([{ kind: 'door', dtype: 'main', origin: 'kr', sides: '1', frame: 0 }], { cust: 'owner', region: '雲嘉投' }, catalog).total, 16000, '手算③門+車馬=16000');
// 電梯地板一片式=12000
eq(eng.quote([{ kind: 'elev-floor', ftype: 'one' }], { cust: 'owner', region: '北北桃' }, catalog).afterDisc, 12000, '手算④電梯地板一片式=12000');

// ── ② 整體折扣：兩片門 9 折 ─────────────────────────────────────────
{ const cart = [{ kind: 'door', dtype: 'main', origin: 'kr', sides: '1', frame: 0 }, { kind: 'door', dtype: 'main', origin: 'kr', sides: '1', frame: 0 }];
  const r = eng.quote(cart, { cust: 'owner', region: '北北桃', disc: 0.9 }, catalog);
  eq(r.sub, 20000, '折扣前小計20000'); eq(r.afterDisc, 18000, '9折後18000'); eq(r.discAmt, 2000, '折扣額2000'); }

// ── ③ 原型函式逐項對拍（transcribe 自 HTML，當 oracle）──────────────
const ceil100 = n => Math.ceil(n / 100) * 100, roundWall = h => Math.round((+h + 10) / 10) * 10, roundElev = h => Math.ceil((+h + 20) / 10) * 10;
function pElevUnit(f) { if (f.flatPrice) return f.shape; if (f.origin === 'kr') return (f.perM <= 1350) ? 220 : (f.shape + 20); return (f.perM <= 2400) ? 300 : (f.shape + 20); }
const FILMS = seed.FILMS, GLASS = seed.GLASS, DOOR = seed.DOOR, LOWMIN = seed.LOWMIN;
const FREIGHT_P = {}; for (const [r, f] of Object.entries(seed.FREIGHT)) FREIGHT_P[r] = f.amount;
function pComputeWalls(walls) { const groups = {}; walls.forEach((it, ci) => { const f = FILMS[it.brand], W = f.width, key = it.brand + '|' + it.idx + '|' + it.work; groups[key] = groups[key] || { f, W, idx: it.idx, work: it.work, full: 0, pieces: [], n: 0 }; const g = groups[key]; g.n++; const H = roundWall(it.h), full = Math.floor(it.w / W), rem = it.w - full * W; g.full += full * (H / 100); if (rem > 0) g.pieces.push({ h: H, w: rem, comb: (it.work === 'plane' && rem < (W - 2)) }); }); const lines = []; Object.keys(groups).forEach(k => { const g = groups[k], W = g.W, Fb = W * 100 / 900, item = g.f.items[g.idx]; const pcs = g.pieces.slice().sort((a, b) => b.h - a.h), strips = []; pcs.forEach(pc => { let placed = false; if (pc.comb) { for (let i = 0; i < strips.length; i++) { const s = strips[i]; if (s.used + pc.w <= W && pc.h <= s.host) { s.used += pc.w; s.mem++; placed = true; break; } } } if (!placed) strips.push({ used: pc.w, host: pc.h, mem: 1 }); }); const packM = strips.reduce((a, s) => a + s.host / 100, 0), m = g.full + packM, cai = m * Fb, unit = item[g.work], amt = ceil100(cai * unit); lines.push({ amount: amt, n: g.n }); }); return lines; }
function pComputeGlass(gl, cust) { const groups = {}; gl.forEach(it => { const item = GLASS[it.cat].items[it.idx], unit = cust === 'owner' ? item.owner : item.designer, key = it.cat + '|' + it.idx + '|' + unit; const cai = it.w * it.h / 900, amt = ceil100(cai * unit); groups[key] = groups[key] || { amount: 0, n: 0 }; groups[key].n++; groups[key].amount += amt; }); return Object.keys(groups).map(k => ({ amount: groups[k].amount, n: groups[k].n })); }
function pElevBox(it) { const f = FILMS[it.brand], W = f.width, Fb = W * 100 / 900, item = f.items[it.idx], unit = pElevUnit({ origin: f.origin, perM: item.perM, shape: item.shape, flatPrice: f.flatPrice }), H = roundElev(it.h); let m = 0; if (it.side) m += Math.ceil(it.side / W) * (H / 100); if (it.backw) m += Math.ceil(it.backw / W) * (H / 100); return ceil100(m * Fb * unit); }
function pElevCeil(it) { const f = FILMS[it.brand], W = f.width, Fb = W * 100 / 900, item = f.items[it.idx], unit = pElevUnit({ origin: f.origin, perM: item.perM, shape: item.shape, flatPrice: f.flatPrice }), ch = roundElev(it.cl), m = Math.ceil(it.cw / W) * (ch / 100); return ceil100(m * Fb * unit); }
function pQuote(cart, opts) {
  const cust = opts.cust || 'owner';
  // 逐列金額：牆面、玻璃，再加電梯/門（合併同規格 sig）
  const lineAmts = [];
  pComputeWalls(cart.filter(c => c.kind === 'wall')).forEach(l => lineAmts.push(l.amount));
  pComputeGlass(cart.filter(c => c.kind === 'glass'), cust).forEach(l => lineAmts.push(l.amount));
  const fx = {}, fxOrder = [];
  cart.forEach(it => {
    let sig, amt;
    if (it.kind === 'elev-box') { amt = pElevBox(it); sig = 'EB|' + it.brand + '|' + it.idx + '|' + it.side + '|' + it.backw + '|' + it.h; }
    else if (it.kind === 'elev-ceil') { amt = pElevCeil(it); sig = 'EC|' + it.brand + '|' + it.idx + '|' + it.cl + '|' + it.cw; }
    else if (it.kind === 'elev-floor') { amt = it.ftype === 'one' ? 12000 : 8000; sig = 'EL|' + it.ftype; }
    else if (it.kind === 'door') { const d = DOOR[it.dtype]; amt = d.frameOnly ? d[it.origin] : d[it.origin][it.sides][it.frame]; sig = 'D|' + it.dtype + '|' + it.origin + '|' + it.sides + '|' + it.frame; }
    else return;
    if (fx[sig] === undefined) fxOrder.push(sig);
    fx[sig] = (fx[sig] || 0) + amt;
  });
  fxOrder.forEach(sig => lineAmts.push(fx[sig]));
  // 整體折扣逐列 round；低消（折後不足補）；車馬費最後加
  const r = parseFloat(opts.disc) || 1;
  const afterDisc = lineAmts.reduce((a, b) => a + (r < 1 ? Math.round(b * r) : b), 0);
  const lowmin = LOWMIN[cust], lowApplied = afterDisc > 0 && afterDisc < lowmin, itemsFinal = lowApplied ? lowmin : afterDisc, freight = FREIGHT_P[opts.region] || 0;
  return { afterDisc, itemsFinal, total: itemsFinal + freight };
}

// 對拍多組情境
const carts = [
  ['複合牆面併料', [
    { kind: 'wall', brand: 'krmerge', idx: 2, work: 'plane', h: 250, w: 300 },
    { kind: 'wall', brand: 'krmerge', idx: 2, work: 'plane', h: 250, w: 80 },
    { kind: 'wall', brand: 'krmerge', idx: 2, work: 'plane', h: 250, w: 90 },
    { kind: 'wall', brand: 'paroi_fr', idx: 3, work: 'cabinet', h: 220, w: 400 },
  ], { cust: 'designer', region: '苗中彰' }],
  ['玻璃多片+門', [
    { kind: 'glass', cat: 'rib', idx: 0, h: 200, w: 90 },
    { kind: 'glass', cat: 'rib', idx: 0, h: 180, w: 90 },
    { kind: 'door', dtype: 'fire-d', origin: 'jp', sides: '2', frame: 1 },
  ], { cust: 'owner', region: '南高' }],
  ['電梯整組', [
    { kind: 'elev-box', brand: 'krmerge', idx: 5, side: 300, backw: 150, h: 230 },
    { kind: 'elev-ceil', brand: 'krmerge', idx: 5, cl: 200, cw: 180 },
    { kind: 'elev-floor', ftype: 'plastic' },
  ], { cust: 'designer', region: '花蓮' }],
  ['折扣+低消', [
    { kind: 'glass', cat: 'fog', idx: 0, h: 100, w: 80 },
  ], { cust: 'designer', region: '北北桃', disc: 0.85 }],
  ['犀牛皮flatPrice牆+電梯', [
    { kind: 'wall', brand: 'rhino', idx: 0, work: 'shape', h: 240, w: 152 },
    { kind: 'elev-box', brand: 'rhino', idx: 0, side: 200, backw: 0, h: 220 },
  ], { cust: 'owner', region: '屏東台東' }],
];
for (const [name, cart, opts] of carts) {
  const mine = eng.quote(cart, opts, catalog);
  const oracle = pQuote(cart, opts);
  eq({ afterDisc: mine.afterDisc, itemsFinal: mine.itemsFinal, total: mine.total }, oracle, `對拍：${name}`);
}

console.log(fails ? `\n❌ ${fails} 項不符` : '\n✅ 全部對拍通過，計價引擎與同事原型一致');
process.exit(fails ? 1 : 0);
