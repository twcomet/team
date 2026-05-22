/**
 * 生產環境一次性資料匯入
 * 在 Zeabur 指令終端執行：node scripts/import-from-json.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_FILE   = process.env.DB_PATH || path.join(__dirname, '..', 'huixin.db');
const JSON_FILE = path.join(__dirname, 'import-data.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

function excelDate(v) {
  if (!v || isNaN(v)) return null;
  const d = new Date((Number(v) - 25569) * 86400 * 1000);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function parseContact(str) {
  if (!str) return {};
  const nameM  = str.match(/聯絡人[姓名]*[：:]\s*([^\r\n◆◇\t]+)/);
  const phoneM = str.match(/(?:手機|電話|連絡電話)[：:]\s*([\d\-\s]+)/);
  return {
    name:  nameM  ? nameM[1].trim().replace(/\t/g, '') : null,
    phone: phoneM ? phoneM[1].replace(/[\s\-]/g, '').slice(0, 20) : null,
  };
}

function hasContact(str) {
  return str && (str.includes('◇') || str.includes('聯絡人') || str.includes('電話'));
}

function looksLikeAddress(str) {
  return str && /[縣市區鄉鎮路街巷弄號樓]/.test(str) && str.length > 10;
}

function cleanKeyword(str) {
  if (!str) return null;
  if (str.startsWith('http') || str.startsWith('◇') || str.startsWith('◆') ||
      /^\d{5,}$/.test(str.trim())) return null;
  return str.replace(/\r\n/g, ' ').replace(/\t/g, ' ').trim().slice(0, 100);
}

function parseSurveyFee(str) {
  if (!str) return null;
  const m = str.match(/(\d[\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : null;
}

function genCaseNumber() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `HX${yy}${mm}`;
  const last = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq  = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function main() {
  // 防重複匯入
  const alreadyImported = db.prepare(`SELECT id FROM cases WHERE notes LIKE '匯入自Excel%' LIMIT 1`).get();
  if (alreadyImported) {
    console.log('⚠️  偵測到已匯入的資料，跳過（防止重複）');
    process.exit(0);
  }

  const rows = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  console.log(`讀取 ${rows.length} 筆資料，開始匯入...\n`);

  const hqOrg   = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const orgId   = hqOrg?.id || null;
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const sysUid  = sysUser?.id || null;

  const userMap = {};
  db.prepare(`SELECT id, name FROM users`).all().forEach(u => { userMap[u.name] = u.id; });

  let created = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const allText = Object.entries(row).map(([k,v]) => `[${k}]${v}`).join(' | ');

    const surveyDate = excelDate(row.B) || excelDate(row.L) || excelDate(row.N);
    const fee = parseSurveyFee(row.C) || parseSurveyFee(row.I);
    const surveyorName = [row.D, row.C, row.A].find(v => userMap[v]);
    const surveyorId   = surveyorName ? userMap[surveyorName] : null;

    let contactName = null, contactPhone = null, address = null;
    for (const col of ['E','F','G','H','I','J']) {
      const v = row[col] || '';
      if (hasContact(v)) {
        const c = parseContact(v);
        if (!contactName  && c.name)  contactName  = c.name;
        if (!contactPhone && c.phone) contactPhone = c.phone;
      }
      if (!address && looksLikeAddress(v)) address = v.trim();
    }

    let title = null;
    for (const col of ['E','H','G','F','C']) {
      title = cleanKeyword(row[col]);
      if (title) break;
    }
    if (!title) title = `匯入案件 #${i+1}`;

    let clientId = null;
    if (contactPhone) {
      const existing = db.prepare(`SELECT id FROM clients WHERE phone=? LIMIT 1`).get(contactPhone);
      if (existing) {
        clientId = existing.id;
      } else if (contactName) {
        const r = db.prepare(`INSERT INTO clients (org_id, name, phone, source, created_by) VALUES (?,?,?,?,?)`)
          .run(orgId, contactName, contactPhone, '匯入', sysUid);
        clientId = r.lastInsertRowid;
      }
    }

    const notes = `匯入自Excel第${i+2}行\n場勘日期：${surveyDate||'—'} 場勘費：${fee ? fee+'元':'—'}\n原始資料：${allText}`;
    const caseNumber = genCaseNumber();

    db.prepare(`
      INSERT INTO cases (
        case_number, org_id, case_type, client_id, title,
        location, survey_fee, sales_id,
        status, priority, notes,
        scheduled_date, created_by, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,'survey','normal',?,?,?,CURRENT_TIMESTAMP)
    `).run(caseNumber, orgId, 'survey', clientId, title, address, fee,
           surveyorId || sysUid, notes, surveyDate, sysUid);

    console.log(`✓ ${caseNumber} | ${title.slice(0,40)} | ${surveyDate||'無日期'}`);
    created++;
  }

  console.log(`\n✅ 完成：新建 ${created} 筆案件`);
}

main();
