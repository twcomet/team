// AI 用量記錄：每次呼叫 Anthropic API 後記一筆到 ai_usage_log。
// 花費為「估算」（依下方單價表），實際以 Anthropic 帳單為準。

// 每 1M tokens 的美金估算單價（input / output）
const PRICING = {
  'claude-sonnet-5':           { in: 3,  out: 15 },
  'claude-opus-4-8':           { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1,  out: 5 },
  default:                     { in: 3,  out: 15 },
};

// 功能代碼 → 中文顯示名（給儀表板用）
const FEATURE_LABEL = {
  line_ai_draft:     'LINE AI 建議回覆',
  line_ai_assistant: 'LINE 問 AI 助手 / 潤飾',
  line_ai_estimate:  'LINE AI 估價輔助',
  cs_knowledge_mine: '客服知識庫·AI 挖常見問題',
  ai_advisor_brief:  'AI 顧問·摘要',
  ai_advisor_chat:   'AI 顧問·對話',
  estimator_ocr:     '估價機·OCR 尺寸辨識',
  ledger_scan:       '記帳·收據辨識',
  client_ocr_card:   '客戶·名片辨識',
  unknown:           '其他',
};

function estCostUsd(model, inTok, outTok) {
  const p = PRICING[model] || PRICING.default;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// 從 Anthropic 回傳的 data 物件記一筆用量。永不拋錯（記錄失敗不可影響主流程）。
function logUsage(db, { feature, userId = null, model, data } = {}) {
  try {
    const u = (data && data.usage) || {};
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const cost = estCostUsd(model, inTok, outTok);
    db.prepare(`INSERT INTO ai_usage_log (feature, user_id, model, input_tokens, output_tokens, est_cost_usd)
                VALUES (?,?,?,?,?,?)`)
      .run(feature || 'unknown', userId, model || '', inTok, outTok, cost);
  } catch (e) { /* 靜默：監控不能拖垮功能 */ }
}

module.exports = { PRICING, FEATURE_LABEL, estCostUsd, logUsage };
