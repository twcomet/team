// 計價引擎測試（重設計版）：lib/estimator.js + lib/estimator-catalog.js。
// 手算絕對值錨點 + 規則驗證（低消/折扣/車馬費/期貨不打折）。不符即 exit 1。執行：node scripts/estimator-check.js
const eng = require('../lib/estimator');
const cat = require('../lib/estimator-catalog');

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { console.error(`✗ ${msg}\n   got = ${JSON.stringify(got)}\n   want= ${JSON.stringify(want)}`); fails++; }
  else console.log(`✓ ${msg}`);
};
const Q = (cart, opts) => eng.quote(cart, opts, cat);

// ── ① 牆面（裝潢膜）手算 ────────────────────────────────────────────
// bodaq 不防焰 idx1 (BA/W 木紋, plane130) 122寬, h250 w220 →
//   H=260, full=1(122) rem=98(comb), m=1*2.6+2.6=5.2, Fb=13.5556, cai=70.489 ×130 → ceil100=9200
eq(Q([{ kind: 'film', brand: 'bodaq', idx: 1, work: 'plane', h: 250, w: 220 }], { cust: 'designer', region: '北北桃' }).afterDisc, 9200, '手算①牆面 bodaq不防焰 BA/W=9200');
// 同款 系統櫃(cabinet 150)：cai同 70.489 ×150=10573.4 → 10600（系統櫃不併料但單片 rem 仍計；此處單片）
{ const r = Q([{ kind: 'film', brand: 'bodaq', idx: 1, work: 'cabinet', h: 250, w: 220 }], { cust: 'designer', region: '北北桃' });
  eq(r.afterDisc, 10600, '手算②系統櫃 cabinet150=10600'); }

// ── ② 玻璃（沿用同事）：fog owner120, h200 w100 → cai22.222 ×120=2666.7→2700，未達低消補10000 ──
{ const r = Q([{ kind: 'glass', cat: 'fog', idx: 0, h: 200, w: 100 }], { cust: 'owner', region: '北北桃' });
  eq(r.afterDisc, 2700, '手算③玻璃=2700'); eq(r.lowApplied, true, '③未達低消'); eq(r.itemsFinal, 10000, '③補到低消10000'); eq(r.total, 10000, '③總價(北北桃車馬0)'); }

// ── ③ 門（真實表）────────────────────────────────────────────────────
eq(Q([{ kind: 'door', cat: 'main', origin: 'kr', side: 'single', frame: 'yes' }], { cust: 'owner', region: '北北桃' }).afterDisc, 13000, '手算④大門韓單面含框=13000');
eq(Q([{ kind: 'door', cat: 'fire', origin: 'jp', side: 'double', size: 'small' }], { cust: 'owner', region: '北北桃' }).afterDisc, 25000, '手算⑤防火門日小座雙面=25000');
eq(Q([{ kind: 'door', cat: 'room', origin: 'jp', side: 'double', frame: 'yes' }], { cust: 'owner', region: '北北桃' }).afterDisc, 19500, '手算⑥房門日雙面含框=19500');

// ── ④ 電梯地板固定價 ＋ 車馬費 ───────────────────────────────────────
eq(Q([{ kind: 'elev-floor', ftype: 'one' }], { cust: 'owner', region: '雲嘉投' }).total, 12000 + 6000, '手算⑦電梯地板一片式12000+車馬6000=18000');

// ── ⑤ 折扣（門 9 折）＋ 期貨運費不打折 ──────────────────────────────
{ const cart = [
    { kind: 'door', cat: 'main', origin: 'kr', side: 'single', frame: 'no' }, // 10000
    { kind: 'fut', origin: 'kr', method: 'air' },                              // 6000（不打折）
  ];
  const r = Q(cart, { cust: 'owner', region: '北北桃', disc: 0.9 });
  eq(r.sub, 10000, '⑧折前小計(不含運費)=10000'); eq(r.afterDisc, 9000, '⑧9折=9000');
  eq(r.fut, 6000, '⑧期貨運費6000不打折'); eq(r.itemsFinal, 10000, '⑧折後9000<低消補10000');
  eq(r.total, 16000, '⑧總價=低消10000+期貨6000'); }

// ── ⑥ 期貨運費規則（韓海運3000/空運6000、日空運6000）──────────────────
eq(Q([{ kind: 'fut', origin: 'kr', method: 'sea' }], { cust: 'owner', region: '北北桃' }).fut, 3000, '⑨韓海運=3000');
eq(Q([{ kind: 'fut', origin: 'jp', method: 'air' }], { cust: 'owner', region: '北北桃' }).fut, 6000, '⑨日空運=6000');

// ── ⑦ 牆面併料：兩片同款平面拼條省料（金額 < 兩片各算）──────────────────
{ const one = Q([{ kind: 'film', brand: 'benif', idx: 0, work: 'plane', h: 250, w: 60 }], { cust: 'owner', region: '北北桃' }).afterDisc;
  const two = Q([
    { kind: 'film', brand: 'benif', idx: 0, work: 'plane', h: 250, w: 60 },
    { kind: 'film', brand: 'benif', idx: 0, work: 'plane', h: 250, w: 60 },
  ], { cust: 'owner', region: '北北桃' }).afterDisc;
  eq(two < one * 2, true, `⑩併料省料：兩片(${two}) < 兩倍單片(${one * 2})`); }

console.log(fails ? `\n❌ ${fails} 項不符` : '\n✅ 全部通過，重設計版計價引擎正確');
process.exit(fails ? 1 : 0);
