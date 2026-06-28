const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 只有老闆 / 管理員 / 有報價設定權限者可改價目
function canEditPrices(u) {
  if (!u) return false;
  if (u.role === 'owner' || u.manage_users) return true;
  const p = u.permissions || {};
  return p.page_quote_settings === true;
}
function requireEdit(req, res, next) {
  if (!canEditPrices(req.session.user)) return res.status(403).json({ error: '沒有修改價目的權限' });
  next();
}

// ── 讀全部價目（估價頁與設定頁共用）──────────────────────────────
router.get('/prices', requireAuth, (req, res) => {
  const films = db.prepare(`SELECT * FROM est_films ORDER BY sort_order, id`).all();
  const glass = db.prepare(`SELECT * FROM est_glass ORDER BY sort_order, id`).all();
  const doors = db.prepare(`SELECT * FROM est_doors ORDER BY sort_order, id`).all();
  const freight = db.prepare(`SELECT * FROM est_freight ORDER BY sort_order, id`).all();
  const lo = db.prepare(`SELECT key,value FROM settings WHERE key IN ('est_lowmin_owner','est_lowmin_designer')`).all();
  const lowmin = {
    owner: Number(lo.find(x => x.key === 'est_lowmin_owner')?.value || 10000),
    designer: Number(lo.find(x => x.key === 'est_lowmin_designer')?.value || 9000),
  };
  res.json({ films, glass, doors, freight, lowmin });
});

// ── 改單筆價目 ───────────────────────────────────────────────────
router.put('/films/:id', requireAuth, requireEdit, (req, res) => {
  const { per_m, plane, cabinet, shape, active } = req.body;
  db.prepare(`UPDATE est_films SET per_m=?,plane=?,cabinet=?,shape=?,active=? WHERE id=?`)
    .run(Number(per_m)||0, Number(plane)||0, Number(cabinet)||0, Number(shape)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

router.put('/glass/:id', requireAuth, requireEdit, (req, res) => {
  const { owner_price, designer_price, active } = req.body;
  db.prepare(`UPDATE est_glass SET owner_price=?,designer_price=?,active=? WHERE id=?`)
    .run(Number(owner_price)||0, Number(designer_price)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

router.put('/doors/:id', requireAuth, requireEdit, (req, res) => {
  const { price, active } = req.body;
  db.prepare(`UPDATE est_doors SET price=?,active=? WHERE id=?`)
    .run(Number(price)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

router.put('/freight/:id', requireAuth, requireEdit, (req, res) => {
  const { survey_fee, amount, overnight_fee, night_surcharge } = req.body;
  db.prepare(`UPDATE est_freight SET survey_fee=?, amount=?, overnight_fee=?, night_surcharge=? WHERE id=?`)
    .run(Number(survey_fee)||0, Number(amount)||0, Number(overnight_fee)||0, Number(night_surcharge)||0, req.params.id);
  res.json({ ok: true });
});

router.put('/lowmin', requireAuth, requireEdit, (req, res) => {
  const { owner, designer } = req.body;
  db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Number(owner)||0));
  db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_designer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Number(designer)||0));
  res.json({ ok: true });
});

// ── 回復預設值（清空後重新 seed）────────────────────────────────
router.post('/reset-defaults', requireAuth, requireEdit, (req, res) => {
  const seed = require('../lib/estimator-seed');
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM est_films; DELETE FROM est_glass; DELETE FROM est_doors; DELETE FROM est_freight;`);
    const insF = db.prepare(`INSERT INTO est_films (grp_key,grp_label,origin,width,flat_price,sys,per_m,plane,cabinet,shape,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [gk, g] of Object.entries(seed.FILMS))
      g.items.forEach(it => insF.run(gk, g.label, g.origin, g.width, g.flatPrice ? 1 : 0, it.sys, it.perM, it.plane, it.cabinet, it.shape, so++));
    const insG = db.prepare(`INSERT INTO est_glass (cat_key,cat_label,sys,owner_price,designer_price,sort_order) VALUES (?,?,?,?,?,?)`);
    so = 0;
    for (const [ck, c] of Object.entries(seed.GLASS))
      c.items.forEach(it => insG.run(ck, c.label, it.sys, it.owner, it.designer, so++));
    const insD = db.prepare(`INSERT INTO est_doors (door_key,label,frame_only,origin,layers,opt,price,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    so = 0;
    for (const [dk, d] of Object.entries(seed.DOOR)) {
      if (d.frameOnly) { insD.run(dk, d.label, 1, 'kr', null, null, d.kr, so++); insD.run(dk, d.label, 1, 'jp', null, null, d.jp, so++); }
      else for (const origin of ['kr', 'jp']) for (const layers of ['1', '2']) for (const opt of [0, 1]) insD.run(dk, d.label, 0, origin, layers, opt, d[origin][layers][opt], so++);
    }
    const insFr = db.prepare(`INSERT INTO est_freight (region,survey_fee,amount,overnight_fee,night_surcharge,sort_order) VALUES (?,?,?,?,?,?)`);
    so = 0;
    for (const [region, f] of Object.entries(seed.FREIGHT)) insFr.run(region, f.survey_fee, f.amount, f.overnight_fee, f.night_surcharge, so++);
    db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(seed.LOWMIN.owner));
    db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_designer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(seed.LOWMIN.designer));
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
