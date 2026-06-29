// 計價引擎測試（寬鬆/拼料雙模式）：lib/estimator.js + lib/estimator-catalog.js
// 預設＝寬鬆(膜寬×高·需要幾條)；combine:true＝拼料省料。不符即 exit 1。執行：node scripts/estimator-check.js
const eng = require('../lib/estimator');
const cat = require('../lib/estimator-catalog');

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { console.error(`✗ ${msg}\n   got = ${JSON.stringify(got)}\n   want= ${JSON.stringify(want)}`); fails++; }
  else console.log(`✓ ${msg}`);
};
const Q = (cart, opts) => eng.quote(cart, opts, cat);

// ── ① 牆面 寬鬆(預設)：bodaq idx1 plane130, 122寬, h250 w220 →
//   需要 ceil(220/122)=2 條 → 2×122×250/900=67.78才 ×130 → ceil100=8900
eq(Q([{ kind: 'film', brand: 'bodaq', idx: 1, work: 'plane', h: 250, w: 220 }], { cust: 'designer', region: '北北桃' }).afterDisc, 8900, '①牆面寬鬆=8900');
// 同款 拼料(combine)：H260 full1(122)+rem98拼 → m=2.6+2.6=5.2 ×Fb13.556 ×130 → 9200
eq(Q([{ kind: 'film', brand: 'bodaq', idx: 1, work: 'plane', h: 250, w: 220 }], { cust: 'designer', region: '北北桃', combine: true }).afterDisc, 9200, '①牆面拼料=9200');

// ── ② 玻璃 寬鬆：fog owner120 W122 h200 w100 → 1條×122×200/900=27.1才 ×120=3253→3300，未達低消補10000 ──
{ const r = Q([{ kind: 'glass', cat: 'fog', idx: 0, h: 200, w: 100 }], { cust: 'owner', region: '北北桃' });
  eq(r.afterDisc, 3300, '②玻璃寬鬆=3300'); eq(r.itemsFinal, 10000, '②補低消10000'); eq(r.total, 10000, '②總價'); }

// ── ③ 門（固定價·不受模式影響）────────────────────────────────────
eq(Q([{ kind: 'door', cat: 'main', origin: 'kr', side: 'single', frame: 'yes' }], { cust: 'owner', region: '北北桃' }).afterDisc, 13000, '③大門韓單面含框=13000');
eq(Q([{ kind: 'door', cat: 'fire', origin: 'jp', side: 'double', size: 'small' }], { cust: 'owner', region: '北北桃' }).afterDisc, 25000, '③防火門日小座雙面=25000');

// ── ④ 電梯地板固定 ＋ 車馬費 ───────────────────────────────────────
eq(Q([{ kind: 'elev-floor', ftype: 'one' }], { cust: 'owner', region: '雲嘉投' }).total, 18000, '④電梯地板12000+車馬6000=18000');

// ── ⑤ 物件：單價×數量 ─────────────────────────────────────────────
eq(Q([{ kind: 'object', name: '造型物件', price: 5000 }, { kind: 'object', name: '造型物件', price: 5000 }], { cust: 'owner', region: '北北桃' }).afterDisc, 10000, '⑤物件2×5000=10000');

// ── ⑥ 折扣(門9折)＋期貨運費不打折 ───────────────────────────────────
{ const r = Q([{ kind: 'door', cat: 'main', origin: 'kr', side: 'single', frame: 'no' }, { kind: 'fut', origin: 'kr', method: 'air' }], { cust: 'owner', region: '北北桃', disc: 0.9 });
  eq(r.fut, 6000, '⑥期貨6000不打折'); eq(r.total, 16000, '⑥折後補低消10000+期貨6000=16000'); }

// ── ⑦ 拼料省料：兩片同款窄牆，拼料 < 寬鬆(各自整條) ──────────────────
{ const cart = [{ kind: 'film', brand: 'benif', idx: 0, work: 'plane', h: 250, w: 60 }, { kind: 'film', brand: 'benif', idx: 0, work: 'plane', h: 250, w: 60 }];
  const loose = Q(cart, { cust: 'owner', region: '北北桃' }).afterDisc;
  const comb = Q(cart, { cust: 'owner', region: '北北桃', combine: true }).afterDisc;
  eq(comb < loose, true, `⑦拼料省料：拼料(${comb}) < 寬鬆(${loose})`); }

// ── ⑧ 造型(shape)永遠獨立(不受 combine 影響·用膜寬×高)──────────────────
{ const c = [{ kind: 'film', brand: 'bodaq', idx: 0, work: 'shape', h: 240, w: 120 }];
  eq(Q(c, { cust: 'owner', region: '北北桃' }).afterDisc, Q(c, { cust: 'owner', region: '北北桃', combine: true }).afterDisc, '⑧造型不受拼料切換影響'); }

// ── ⑨ DB 牌價路徑與 JS 對拍(寬鬆＋拼料都測)──────────────────────────
try {
  const db = require('../db');
  const dbCat = eng.buildCatalogFromDb(db);
  const carts = [
    [{ kind: 'film', brand: 'bodaq', idx: 1, work: 'plane', h: 250, w: 220 }],
    [{ kind: 'glass', cat: 'fog', idx: 0, h: 200, w: 100 }],
    [{ kind: 'door', cat: 'fire', origin: 'jp', side: 'double', size: 'small' }],
  ];
  [false, true].forEach(cb => carts.forEach((c, i) => {
    const a = eng.quote(c, { cust: 'owner', region: '雲嘉投', combine: cb }, cat).total;
    const b = eng.quote(c, { cust: 'owner', region: '雲嘉投', combine: cb }, dbCat).total;
    eq(b, a, `⑨DB對拍 combine=${cb} #${i + 1}（${a}）`);
  }));
} catch (e) { console.error('✗ DB 對拍失敗', e.message); fails++; }

console.log(fails ? `\n❌ ${fails} 項不符` : '\n✅ 全部通過（寬鬆/拼料雙模式）');
process.exit(fails ? 1 : 0);
