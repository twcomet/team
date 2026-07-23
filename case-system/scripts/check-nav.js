#!/usr/bin/env node
/**
 * 側邊選單完整性檢查（防復發護欄）
 *
 * 歷史 bug：新頁面（after-sales/door-price）帶了「空的」或「殘缺的舊版」sidebar-nav，
 * 導致使用者在那頁只看到缺一半的選單。這支腳本掃所有「有 sidebar-nav 的完整頁面」，
 * data-page 數量過少就報錯（正常約 39 項）。
 *
 * 新頁面請直接複製一份標準 sidebar-nav（見 public/clients.html 等），不要留空或自己刪減。
 *
 * 用法：node scripts/check-nav.js（不合格 → 退出碼 1）
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public');

const MIN = 35;   // 完整選單約 39 項，低於此視為殘缺
// 已知例外：
//  acceptance-list.html — 孤兒頁（無路由、未被連結，驗收單已搬到 after-sales）
//  quote-preview.html   — 設計示意頁，側邊選單是裝飾用假連結(href="#")、非真功能頁
const IGNORE = new Set(['acceptance-list.html', 'quote-preview.html']);

const problems = [];
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.html'))) {
  if (IGNORE.has(f)) continue;
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/class="sidebar-nav"/.test(html)) continue;          // 沒側邊選單的頁（登入/簽署等）跳過
  const navBlock = (html.match(/<nav class="sidebar-nav">[\s\S]*?<\/nav>/) || [''])[0];
  const count = (navBlock.match(/data-page="/g) || []).length;
  if (count < MIN) problems.push(`  ✗ ${f.padEnd(26)} 只有 ${count} 個選單項（應約 39）`);
}

if (problems.length) {
  console.error(`❌ 側邊選單殘缺（${problems.length} 頁）：`);
  console.error(problems.join('\n'));
  console.error('\n請把該頁的 <nav class="sidebar-nav"> 換成完整標準選單（複製 public/clients.html 的）。');
  process.exit(1);
}
console.log('✅ 所有完整頁面的側邊選單都齊全');
