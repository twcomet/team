/**
 * 一次性匯入腳本：場勘+成交進行案件.xlsx
 * 用法：node scripts/import-excel.js /path/to/file.xlsx
 * 或直接執行（預設讀同目錄下的 import-data.xlsx）
 */

const { DatabaseSync } = require('node:sqlite');
const path  = require('path');
const fs    = require('fs');
const { execSync } = require('child_process');

const DB_FILE  = process.env.DB_PATH || path.join(__dirname, '..', 'huixin.db');
const XLSX     = process.argv[2] || path.join(__dirname, '..', '場勘+成交進行案件.xlsx');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

// ── Excel 解析 ────────────────────────────────────────────────

function parseXlsx(filePath) {
  const tmpDir = `/tmp/xlsx_import_${Date.now()}`;
  execSync(`mkdir -p ${tmpDir} && unzip -o "${filePath}" -d ${tmpDir} > /dev/null 2>&1`);

  // shared strings
  let strings = [];
  try {
    const ssXml = fs.readFileSync(`${tmpDir}/xl/sharedStrings.xml`, 'utf8');
    const m = ssXml.match(/<t[^>]*>([^<]*)<\/t>/g) || [];
    strings = m.map(x => x.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
  } catch {}

  const sheetXml = fs.readFileSync(`${tmpDir}/xl/worksheets/sheet1.xml`, 'utf8');
  const rowMatches = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];

  const rows = rowMatches.map(row => {
    const cells = {};
    (row.match(/<c[^>]*>[\s\S]*?<\/c>/g) || []).forEach(cell => {
      const r = cell.match(/r="([A-Z]+)\d+"/);
      if (!r) return;
      const col = r[1];
      const t = (cell.match(/t="([^"]*)"/) || [])[1];
      const v = (cell.match(/<v>([^<]*)<\/v>/) || [])[1];
      if (!v) { cells[col] = ''; return; }
      cells[col] = (t === 's') ? (strings[parseInt(v)] || '') : v;
    });
    return cells;
  });

  execSync(`rm -rf ${tmpDir}`);
  return rows;
}

// ── 工具函式 ──────────────────────────────────────────────────

// Excel serial → YYYY-MM-DD
function excelDate(v) {
  if (!v || isNaN(v)) return null;
  const ms = (Number(v) - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

// 從含 ◇◆ 格式的字串抽取聯絡人姓名和電話
function parseContact(str) {
  if (!str) return {};
  const nameM  = str.match(/聯絡人[姓名]*[：:]\s*([^\r\n◆◇\t]+)/);
  const phoneM = str.match(/(?:手機|電話|連絡電話)[：:]\s*([\d\-\s]+)/);
  return {
    name:  nameM  ? nameM[1].trim().replace(/\t/g,'')  : null,
    phone: phoneM ? phoneM[1].replace(/[\s\-]/g,'').slice(0,20) : null,
  };
}

// 從 keyword 欄抽取地點/類型 作為案件標題
function cleanKeyword(str) {
  if (!str) return null;
  if (str.startsWith('http') || str.startsWith('◇') || str.startsWith('◆') ||
      /^\d{5,}$/.test(str.trim())) return null;
  return str.replace(/\r\n/g, ' ').replace(/\t/g, ' ').trim().slice(0, 100);
}

// 場勘費解析
function parseSurveyFee(str) {
  if (!str) return null;
  const m = str.match(/(\d[\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g,'')) : null;
}

// 判斷字串是否含聯絡資訊
function hasContact(str) {
  return str && (str.includes('◇') || str.includes('聯絡人') || str.includes('電話'));
}

// 判斷字串是否為地址
function looksLikeAddress(str) {
  if (!str) return false;
  return /[縣市區鄉鎮路街巷弄號樓]/.test(str) && str.length > 10;
}

// 案件流水號
function genCaseNumber() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `HX${yy}${mm}`;
  const last = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq  = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

// ── 主要匯入邏輯 ──────────────────────────────────────────────

function main() {
  console.log(`\n匯入來源：${XLSX}`);
  console.log(`資料庫：${DB_FILE}\n`);

  if (!fs.existsSync(XLSX)) {
    console.error('❌ 找不到 Excel 檔案：', XLSX);
    process.exit(1);
  }

  const rows = parseXlsx(XLSX);
  console.log(`讀取到 ${rows.length} 行（含標題）`);

  // 取得預設 org 和 system user
  const hqOrg   = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const orgId   = hqOrg?.id || null;
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const sysUid  = sysUser?.id || null;

  // 使用者名稱對照
  const userMap = {};
  db.prepare(`SELECT id, name FROM users`).all().forEach(u => {
    userMap[u.name] = u.id;
    // 常見別名
    if (u.name === '佳樺') userMap['flora'] = u.id;
  });

  let created = 0, skipped = 0;

  // 跳過第 1 行（標題）
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const vals = Object.values(row).filter(Boolean);
    if (vals.length < 2) { skipped++; continue; }

    const cells = Object.values(row);
    const allText = Object.entries(row).map(([k,v]) => `[${k}]${v}`).join(' | ');

    // 場勘日期
    const surveyDate = excelDate(row.B) || excelDate(row.L) || excelDate(row.N);

    // 場勘費
    const fee = parseSurveyFee(row.C) || parseSurveyFee(row.I);

    // 場勘人 → user id
    const surveyorName = [row.D, row.C, row.A].find(v => userMap[v]);
    const surveyorId   = surveyorName ? userMap[surveyorName] : null;

    // 找客戶聯絡資訊
    let contactName = null, contactPhone = null, address = null;
    for (const col of ['E','F','G','H','I','J']) {
      const v = row[col] || '';
      if (hasContact(v)) {
        const c = parseContact(v);
        if (!contactName && c.name)  contactName = c.name;
        if (!contactPhone && c.phone) contactPhone = c.phone;
      }
      if (!address && looksLikeAddress(v)) address = v.trim();
    }

    // 案件標題 — 從 keyword 欄位取
    let title = null;
    for (const col of ['E','H','G','F','C']) {
      title = cleanKeyword(row[col]);
      if (title) break;
    }
    if (!title) title = `匯入案件 #${i}`;

    // 找或建立客戶
    let clientId = null;
    if (contactPhone) {
      const existing = db.prepare(`SELECT id FROM clients WHERE phone=? LIMIT 1`).get(contactPhone);
      if (existing) {
        clientId = existing.id;
      } else if (contactName) {
        const r = db.prepare(`INSERT INTO clients (org_id, name, phone, source, created_by) VALUES (?,?,?,?,?)`)
          .run(orgId, contactName, contactPhone, '匯入', sysUid);
        clientId = r.lastInsertRowid;
        console.log(`  + 客戶：${contactName} ${contactPhone}`);
      }
    }

    // 案件備註 — 保留原始資料
    const notes = `[匯入自Excel第${i+1}行]\n場勘日期：${surveyDate||'—'} 場勘費：${fee ? fee+'元':'—'}\n原始資料：${allText}`;

    const caseNumber = genCaseNumber();
    db.prepare(`
      INSERT INTO cases (
        case_number, org_id, case_type, client_id, title,
        location, survey_fee, sales_id,
        status, priority, notes,
        scheduled_date, created_by, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,'surveyed','normal',?,?,?,CURRENT_TIMESTAMP)
    `).run(
      caseNumber, orgId, 'survey', clientId, title,
      address, fee, surveyorId || sysUid,
      notes,
      surveyDate, sysUid
    );

    console.log(`  ✓ ${caseNumber} | ${title.slice(0,40)} | ${surveyDate||'無日期'}`);
    created++;
  }

  console.log(`\n完成：新建 ${created} 筆案件，略過 ${skipped} 筆空行`);
}

main();
