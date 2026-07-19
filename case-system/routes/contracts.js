const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const db       = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router   = express.Router();

// 上傳目錄放在永久磁碟（與資料庫同一個 volume），避免重新部署被清掉
const DATA_DIR   = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'contracts');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer 的 originalname 對非 ASCII 檔名是 latin1，轉回 UTF-8 才不會亂碼
function decodeOriginalName(file) {
  return file ? Buffer.from(file.originalname, 'latin1').toString('utf8') : null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('只允許上傳 PDF 檔案'));
  },
});

function isAdmin(req) {
  const u = req.session?.user;
  return u && (u.role === 'owner' || u.manage_users);
}

// ── 取得所有合約（admin）──────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rows = db.prepare(`
      SELECT c.*,
        u.name as creator_name,
        (SELECT COUNT(*) FROM contract_assignments WHERE contract_id=c.id) as assign_count,
        (SELECT COUNT(*) FROM contract_signatures  WHERE contract_id=c.id) as sign_count
      FROM contracts c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/contracts]', e.message);
    res.status(500).json({ error: 'contracts 查詢失敗：' + e.message });
  }
});

// ── 新增合約（PDF 為選填，content 文字為主）──────────────────
router.post('/', requireAuth, (req, res, next) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}, upload.single('file'), (req, res) => {
  const { title, description, content } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '請填寫合約名稱' });
  if (!content?.trim() && !req.file) return res.status(400).json({ error: '請輸入合約內容或上傳 PDF' });

  const r = db.prepare(`INSERT INTO contracts (title, description, content, filename, original_name, created_by) VALUES (?,?,?,?,?,?)`)
    .run(
      title.trim(),
      description?.trim() || null,
      content?.trim() || null,
      req.file ? req.file.filename : null,
      decodeOriginalName(req.file),
      req.session.user.id,
    );

  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── 更新合約內容（admin）─────────────────────────────────────
router.put('/:id', requireAuth, (req, res, next) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}, upload.single('file'), (req, res) => {
  const { title, description, content } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '請填寫合約名稱' });

  const existing = db.prepare(`SELECT filename FROM contracts WHERE id=?`).get(req.params.id);
  const newFilename = req.file ? req.file.filename : existing?.filename || null;
  const newOriginal = req.file ? decodeOriginalName(req.file) : (existing ? db.prepare(`SELECT original_name FROM contracts WHERE id=?`).get(req.params.id)?.original_name : null);

  db.prepare(`UPDATE contracts SET title=?, description=?, content=?, filename=?, original_name=? WHERE id=?`)
    .run(title.trim(), description?.trim() || null, content?.trim() || null, newFilename, newOriginal || null, req.params.id);
  res.json({ ok: true });
});

// ── 取得合約 HTML 內容（員工閱讀用）──────────────────────────
router.get('/:id/content', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const contract = db.prepare(`SELECT id, title, content FROM contracts WHERE id=? AND active=1`).get(req.params.id);
  if (!contract) return res.status(404).json({ error: '找不到合約' });

  if (!isAdmin(req)) {
    const assigned = db.prepare(`SELECT id FROM contract_assignments WHERE contract_id=? AND user_id=?`).get(req.params.id, uid);
    if (!assigned) return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ title: contract.title, content: contract.content || '' });
});

// ── 刪除合約（停用，不刪檔案，保留簽署紀錄）────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE contracts SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 取得 PDF 檔案（admin 或被指派此合約的員工，供簽署頁檢視）──────
router.get('/:id/file', requireAuth, (req, res) => {
  if (!isAdmin(req)) {
    const assigned = db.prepare(`SELECT 1 FROM contract_assignments WHERE contract_id=? AND user_id=?`)
      .get(req.params.id, req.session.user.id);
    if (!assigned) return res.status(403).json({ error: 'Forbidden' });
  }
  const contract = db.prepare(`SELECT * FROM contracts WHERE id=?`).get(req.params.id);
  if (!contract) return res.status(404).json({ error: '找不到合約' });

  const filePath = path.join(UPLOAD_DIR, contract.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(contract.original_name || contract.filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── 取得合約指派 + 簽署狀態（admin）──────────────────────────
router.get('/:id/status', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const contract = db.prepare(`SELECT * FROM contracts WHERE id=?`).get(req.params.id);
  if (!contract) return res.status(404).json({ error: '找不到合約' });

  const rows = db.prepare(`
    SELECT ca.id, ca.user_id, ca.assigned_at, ca.notified_at,
           u.name, u.role, u.department,
           cs.signed_at, cs.signed_name
    FROM contract_assignments ca
    JOIN users u ON u.id = ca.user_id
    LEFT JOIN contract_signatures cs ON cs.contract_id=ca.contract_id AND cs.user_id=ca.user_id
    WHERE ca.contract_id=?
    ORDER BY cs.signed_at NULLS LAST, u.name
  `).all(req.params.id);

  res.json({ contract, assignments: rows });
});

// ── 指派合約給使用者（admin）──────────────────────────────────
router.post('/:id/assign', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { user_ids } = req.body;
  if (!Array.isArray(user_ids) || !user_ids.length) return res.status(400).json({ error: '請選擇人員' });

  const contract = db.prepare(`SELECT * FROM contracts WHERE id=? AND active=1`).get(req.params.id);
  if (!contract) return res.status(404).json({ error: '找不到合約' });

  const ins = db.prepare(`INSERT OR IGNORE INTO contract_assignments (contract_id, user_id, assigned_by) VALUES (?,?,?)`);
  let added = 0;
  for (const uid of user_ids) {
    const r = ins.run(req.params.id, uid, req.session.user.id);
    if (r.changes) added++;
  }

  res.json({ ok: true, added });
});

// ── 發送通知給未簽署的指派人員（admin）──────────────────────────
router.post('/:id/notify', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const contract = db.prepare(`SELECT * FROM contracts WHERE id=? AND active=1`).get(req.params.id);
  if (!contract) return res.status(404).json({ error: '找不到合約' });

  const unsigned = db.prepare(`
    SELECT ca.user_id, u.name, u.line_user_id
    FROM contract_assignments ca
    JOIN users u ON u.id = ca.user_id
    LEFT JOIN contract_signatures cs ON cs.contract_id=ca.contract_id AND cs.user_id=ca.user_id
    WHERE ca.contract_id=? AND cs.id IS NULL AND u.active=1
  `).all(req.params.id);

  const insN = db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'contract','contracts',?,?)`);
  const updN = db.prepare(`UPDATE contract_assignments SET notified_at=CURRENT_TIMESTAMP WHERE contract_id=? AND user_id=?`);

  for (const u of unsigned) {
    insN.run(u.user_id, `請簽署合約：${contract.title}`, `您有一份待簽合約，請登入系統完成簽署。`, contract.id, '/contract');
    updN.run(req.params.id, u.user_id);
    if (u.line_user_id) {
      pushMessage(u.line_user_id, `📄 請簽署合約\n合約名稱：${contract.title}\n請登入繪新管理系統完成電子簽署。`).catch(() => {});
    }
  }

  res.json({ ok: true, notified: unsigned.length });
});

// ── 移除指派（admin）──────────────────────────────────────────
router.delete('/:id/assign/:userId', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM contract_assignments WHERE contract_id=? AND user_id=?`)
    .run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// ── 取得我的待簽合約（員工）──────────────────────────────────
router.get('/my/pending', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.description, c.original_name, ca.assigned_at
    FROM contract_assignments ca
    JOIN contracts c ON c.id=ca.contract_id AND c.active=1
    LEFT JOIN contract_signatures cs ON cs.contract_id=ca.contract_id AND cs.user_id=ca.user_id
    WHERE ca.user_id=? AND cs.id IS NULL
    ORDER BY ca.assigned_at
  `).all(req.session.user.id);
  res.json(rows);
});

// ── 取得我的已簽合約（員工）──────────────────────────────────
router.get('/my/signed', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.description, cs.signed_at, cs.signed_name
    FROM contract_signatures cs
    JOIN contracts c ON c.id=cs.contract_id
    WHERE cs.user_id=?
    ORDER BY cs.signed_at DESC
  `).all(req.session.user.id);
  res.json(rows);
});

// ── 員工已簽合約（HR 查詢特定員工）──────────────────────────
router.get('/user/:userId/signed', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(`
    SELECT c.id, c.title, cs.signed_at, cs.signed_name
    FROM contract_signatures cs
    JOIN contracts c ON c.id=cs.contract_id
    WHERE cs.user_id=?
    ORDER BY cs.signed_at DESC
  `).all(req.params.userId);
  res.json(rows);
});

// ── 提交合約簽名（員工）──────────────────────────────────────
router.post('/:id/sign', requireAuth, (req, res) => {
  const { signature, agreed } = req.body;
  if (!agreed) return res.status(400).json({ error: '請勾選同意' });
  if (!signature) return res.status(400).json({ error: '請完成手寫簽名' });

  const u   = req.session.user;
  const uid = u.id;

  const assigned = db.prepare(`SELECT id FROM contract_assignments WHERE contract_id=? AND user_id=?`)
    .get(req.params.id, uid);
  if (!assigned) return res.status(403).json({ error: '您未被指派此合約' });

  const existing = db.prepare(`SELECT id FROM contract_signatures WHERE contract_id=? AND user_id=?`)
    .get(req.params.id, uid);
  if (existing) return res.status(409).json({ error: '已完成簽署' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  db.prepare(`INSERT INTO contract_signatures (contract_id, user_id, signed_name, signature, ip_address) VALUES (?,?,?,?,?)`)
    .run(req.params.id, uid, u.name || '', signature, ip || null);

  res.json({ ok: true });

  // 簽署完成 → 產生已簽合約 PDF 備份到 Google Drive「合約簽署 → 合約標題」（best-effort，不阻塞回應）
  try { require('../lib/contract-archive').backupSignedContract(Number(req.params.id), uid); } catch (e) { /* non-critical */ }
});

// ── 刪除某人的簽署紀錄（admin；清除測試簽署，讓對方回到「未簽」可重新簽）──
router.delete('/:id/signature/:userId', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const info = db.prepare(`DELETE FROM contract_signatures WHERE contract_id=? AND user_id=?`).run(req.params.id, req.params.userId);
  res.json({ ok: true, removed: info.changes });
});

// ── 取得某人已簽的合約文件（內容＋手寫簽名），供檢視/列印/下載。本人或管理者可看 ──
router.get('/:id/signed-doc', requireAuth, (req, res) => {
  const targetUid = parseInt(req.query.user_id) || req.session.user.id;
  if (targetUid !== req.session.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const c = db.prepare(`SELECT id, title, content FROM contracts WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到合約' });
  const sig = db.prepare(`SELECT signed_name, signature, signed_at, ip_address FROM contract_signatures WHERE contract_id=? AND user_id=?`).get(req.params.id, targetUid);
  if (!sig) return res.status(404).json({ error: '此人尚未簽署' });
  res.json({ title: c.title, content: c.content || '', signer_name: sig.signed_name, signed_at: sig.signed_at, signature: sig.signature, ip: sig.ip_address });
});

module.exports = router;
