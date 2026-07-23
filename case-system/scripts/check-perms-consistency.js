#!/usr/bin/env node
/**
 * 權限一致性檢查（防復發護欄）
 *
 * 為什麼要有這支：case-system 的「頁面權限」定義散在多處，歷史上多次因為
 * 「加了權限勾選框卻沒補 /api/auth/me」→ 前端讀不到 → 授權了選單不顯示/點了被踢。
 * 這支腳本比對三個真相來源，任何 page_* key 沒同時出現就報錯：
 *   ① public/admin.html 的個人勾選框   perm_page_*
 *   ② public/admin.html 的角色預設勾選框 rolePerm_page_*
 *   ③ routes/auth.js  /me 回傳的 permissions 物件   page_*:
 *
 * 用法：node scripts/check-perms-consistency.js   （不一致 → 退出碼 1）
 *
 * 新增一個頁面權限時，請「同時」改：admin.html(兩份清單+存/讀)、auth.js(/me)、
 * server.js(路由 gate/PAGE_PERMS)、common.js(選單)。前三者本腳本會把關。
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

// page_admin：由 manage_users 驅動、非可勾選權限，故排除比對
const IGNORE = new Set(['page_admin']);

const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const auth  = fs.readFileSync(path.join(root, 'routes/auth.js'), 'utf8');

const uniq = a => [...new Set(a)].sort();
const per  = uniq([...admin.matchAll(/perm_(page_[a-z_]+)/g)].map(m => m[1])).filter(k => !IGNORE.has(k));
const role = uniq([...admin.matchAll(/rolePerm_(page_[a-z_]+)/g)].map(m => m[1])).filter(k => !IGNORE.has(k));
const meBlock = (auth.match(/permissions:\s*\{[\s\S]*?\n {4}\},/) || [''])[0];
const me = uniq([...meBlock.matchAll(/(page_[a-z_]+):/g)].map(m => m[1])).filter(k => !IGNORE.has(k));

const all = uniq([...per, ...role, ...me]);
const problems = [];
for (const k of all) {
  const missing = [];
  if (!per.includes(k))  missing.push('admin個人');
  if (!role.includes(k)) missing.push('admin角色');
  if (!me.includes(k))   missing.push('/me');
  if (missing.length) problems.push(`  ✗ ${k.padEnd(24)} 缺：${missing.join('、')}`);
}

if (problems.length) {
  console.error(`❌ 權限清單不一致（${problems.length} 個 key）：`);
  console.error(problems.join('\n'));
  console.error('\n請把缺的 key 補到對應位置（見本檔開頭說明）。');
  process.exit(1);
}
console.log(`✅ 權限清單一致（${all.length} 個 page_* key，三處齊全）`);
