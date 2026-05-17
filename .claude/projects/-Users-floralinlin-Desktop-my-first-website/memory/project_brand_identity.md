---
name: project-brand-identity
description: TWCOMET 繪新國際有限公司 品牌識別系統視覺語言與 CIS 檔案位置
metadata:
  type: project
---

繪新國際有限公司（法定名稱）的品牌名稱為 **TWCOMET**，官網 twcomet.com。

**Logo 視覺語言（從原始 logo 提取）：**
- 主題：宇宙星空 + Retro-Futuristic synthwave 復古未來感
- 主色：霓虹粉紅 `#FF0080`（Neon Magenta）
- 底色：深太空黑紫 `#0C0920`
- 字體材質：金屬鉻色（Chrome）漸層
- 幾何元素：兩個重疊等邊三角形形成六角星（略旋轉12°），搭配星爆閃光
- 光效：霓虹光暈（filter blur + opacity layering）

**CIS 檔案位置：`/brand/` 目錄**
- `brand/tokens.css` — 所有 CSS 自訂屬性（色彩、字型、間距、動畫等）
- `brand/components.css` — UI 元件庫（按鈕、卡片、Badge、Input、Alert 等）
- `brand/logo-mark.svg` — 幾何星形識別標記 SVG（深色底200×200）
- `brand/logo-lockup.svg` — 橫式組合標（Mark + TWCOMET + 繪新國際有限公司，500×130）
- `brand/index.html` — 完整品牌規範展示頁

**Token 命名規則：** `--tc-[category]-[scale]`
例：`--tc-neon-500`, `--tc-bg-base`, `--tc-sp-4`, `--tc-text-base`

**Why:** 佳樺需要一套可套用在所有 Claude 輔助開發專案的品牌系統。
**How to apply:** 開發任何繪新/TWCOMET 相關前端時，引入 tokens.css + components.css，並遵循深底 + 霓虹粉紅設計語言。
