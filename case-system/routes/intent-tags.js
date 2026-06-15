const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// 內建處理狀態（寫死，不可刪）
const BUILTIN = [
  { value: 'called',        label: '客服打過電話' },
  { value: 'incomplete',    label: '資料不齊' },
  { value: 'waiting_quote', label: '客戶等報價' },
  { value: 'need_survey',   label: '需追蹤場勘' },
];

function isManager(req) {
  const u = req.session?.user;
  return !!u && (u.role === 'owner' || !!u.manage_users || !!u.is_manager);
}

// GET / — 回傳內建 + 自訂標籤（供下拉用）
router.get('/', requireAuth, (req, res) => {
  const custom = db.prepare(`SELECT id, label FROM case_intent_tags WHERE active=1 ORDER BY sort_order, id`).all();
  res.json({ builtin: BUILTIN, custom });
});

// POST / — 新增自訂標籤（客服可用）
router.post('/', requireAuth, (req, res) => {
  const label = (req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: '請輸入標籤名稱' });
  if (BUILTIN.some(b => b.label === label))
    return res.status(409).json({ error: '此標籤已是內建狀態' });
  try {
    // 若曾被軟刪除，重新啟用
    const existing = db.prepare(`SELECT id FROM case_intent_tags WHERE label=?`).get(label);
    if (existing) {
      db.prepare(`UPDATE case_intent_tags SET active=1 WHERE id=?`).run(existing.id);
      return res.json({ ok: true, id: existing.id });
    }
    const r = db.prepare(`INSERT INTO case_intent_tags (label, created_by) VALUES (?,?)`)
      .run(label, req.session.user.id);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '新增失敗' });
  }
});

// DELETE /:id — 軟刪除自訂標籤（限管理者）
router.delete('/:id', requireAuth, (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: '僅管理者可刪除標籤' });
  db.prepare(`UPDATE case_intent_tags SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.BUILTIN = BUILTIN;
