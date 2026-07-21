/* 門片價目表渲染（大門/房門/防火門）——數字直接吃報價設定 est_door_catalog。
   大門＝暖棕金、房門＝灰綠，色系刻意分開。 */
(function () {
  const TYPES = {
    main: {
      key: 'main', name: '大門現貨價格表', sub: '全平面門片｜整圖皆未稅價',
      c1: '#43301f', c2: '#7c5a34', accent: '#b6812f', soft: '#f4ecdd', band: '#efe4cf', text: '#3a2a1a',
      applyNote: '適用於鐵門・硫化銅門',
    },
    room: {
      key: 'room', name: '房門現貨價目表', sub: '全平面門片｜現貨膜料｜整圖皆未稅價',
      c1: '#25423b', c2: '#4c7568', accent: '#3f7d68', soft: '#e6f0ec', band: '#d9e8e2', text: '#1f382f',
      applyNote: '',
    },
    fire: {
      key: 'fire', name: '防火門價目表', sub: '整圖皆未稅價',
      c1: '#5a1f1f', c2: '#9a3b2c', accent: '#c1502f', soft: '#f7e9e4', band: '#f0d8cf', text: '#4a1a15',
      applyNote: '',
    },
  };

  const nt = n => (n == null || n === '') ? '—' : 'NT$ ' + Math.round(Number(n)).toLocaleString();

  // 各膜料 4 格價（不含框/含框 × 單面/雙面），資料來源 est_door_catalog（cat.origin.side.frame）
  function originTable(t, catData, origin, label) {
    const g = (side, frame) => (((catData || {})[origin] || {})[side] || {})[frame];
    return `
      <div class="dm-otbl">
        <div class="dm-obrand">${label}</div>
        <table class="dm-tbl">
          <thead><tr><th></th><th>不含門框</th><th>含門框</th></tr></thead>
          <tbody>
            <tr><td class="dm-rh">單面門片</td><td class="dm-p">${nt(g('single','no'))}</td><td class="dm-p dm-p2">${nt(g('single','yes'))}</td></tr>
            <tr><td class="dm-rh">雙面門片</td><td class="dm-p">${nt(g('double','no'))}</td><td class="dm-p dm-p2">${nt(g('double','yes'))}</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  function noteCard(title, inner) {
    return `<div class="dm-note"><div class="dm-note-t">${title}</div><div class="dm-note-b">${inner}</div></div>`;
  }
  const ul = items => `<ul class="dm-ul">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  const ol = items => `<ol class="dm-ol">${items.map(i => `<li>${i}</li>`).join('')}</ol>`;
  const futures = `
    <div class="dm-fut-row"><b>韓國膜（BODAQ / LG）</b><br>
      空運 <b>$4,500</b> ／一款（約 7–15 工作天，不含假日）<br>
      急件 <b>$6,000</b> ／一款（約 2–5 工作天，不含假日）</div>
    <div class="dm-fut-row" style="margin-top:6px"><b>日本膜（PAROI）</b><br>
      空運 <b>$6,000</b> ／一款（約 3–4 週工作天，不含假日）</div>`;
  const remark = ul(['價格以標準門尺寸計算', '偏遠地區車馬費另計']);

  // 各類型的說明區塊（照 DM 文案）
  function notesFor(type, T) {
    if (type === 'main') {
      return `
        ${noteCard('不含施工項目', ul([
          '<b>底板處理費</b>：底板不平整、生鏽或有溝槽，需請油漆工先補土、打磨後再貼膜。',
          '<b>矽利康收邊</b>：門框與牆面交界建議打矽利康收邊以增加耐用性。',
          '<b>電子鎖拆卸</b>：貼膜前需請電子鎖廠商卸除電子鎖，貼膜後再請廠商裝回。繪新不負責拆卸，若不拆卸則無法一張貼覆，貼膜會有切口。',
          '<b>觸控面板</b>：不建議貼膜且貼膜不保固。',
          '<b>五金鉸鏈</b>：無法貼膜，若有配色美觀考量，建議貼膜前可以請油漆刷色。',
        ]))}
        ${noteCard('門框加價說明', ol([
          '<b>內子母門</b>：加價 3,000~5,000，需傳照片評估加價費用。',
          '<b>溝槽造型</b>：<ul class="dm-ul"><li><b>建議補平後貼膜</b>：價格同平面門片不另加價，報價不含油漆處理費。貼膜前請油漆於補土處漆上與底板同色漆，以免透色痕跡。</li><li><b>露出溝槽</b>：加價 3,000 元。</li><li><b>貼溝槽</b>：加價 3,000 元，因溝槽貼膜後容易浮起，若後續浮起不在保固內。</li></ul>',
        ]))}
        <div class="dm-two">
          ${noteCard('期貨膜料報價另計', futures)}
          ${noteCard('備註', remark)}
        </div>`;
    }
    if (type === 'room') {
      return `
        ${noteCard('造型門片加價說明', ol([
          '非平面門片單座加價 2,000~5,000 元，需傳照片評估加價費用。',
          '<b>巧克力門片</b>：不建議貼膜（費工且耐用度低），建議更換平面門片後再貼膜。',
          '<b>溝槽造型</b>：<ul class="dm-ul"><li><b>建議補平後貼膜</b>：價格同平面門片不另加價，報價不含油漆處理費。貼膜前請油漆於補土處漆上與底板同色漆，以免透色痕跡。</li><li><b>露出溝槽</b>：加價 3,000 元。</li><li><b>貼溝槽</b>：加價 3,000 元。因溝槽貼膜後容易浮起，若後續浮起不在保固內。</li></ul>',
        ]))}
        <div class="dm-two">
          ${noteCard('門框加價說明', ul(['兩層以上門框加價 1,000~5,000 元，需傳近拍照評估。']))}
          ${noteCard('備註', remark)}
        </div>
        ${noteCard('不含施工項目', ul([
          '<b>底板處理費</b>：底板不平整或生鏽或有溝槽，需請油漆工補土打磨後再貼膜。',
          '<b>矽利康收邊</b>：門框與牆面交界建議打矽利康收邊，以增加耐用性。',
        ]))}
        ${noteCard('不保固項目', ul([
          '<b>廁所</b>：潮濕環境不建議施作，會直接淋到水的位置貼膜後不保固。',
          '<b>百葉通風口</b>：不建議貼膜，如需施工需加 3,000 元一式，且不在保固範圍內。',
        ]))}
        ${noteCard('期貨膜料報價另計', futures)}`;
    }
    return noteCard('備註', remark);
  }

  function render(type, data) {
    const T = TYPES[type] || TYPES.main;
    const cat = (data && data[type]) || {};
    const styleVars = `--c1:${T.c1};--c2:${T.c2};--accent:${T.accent};--soft:${T.soft};--band:${T.band};--dtext:${T.text}`;
    return `
      <div class="dm-sheet sheet-capture" style="${styleVars}">
        <div class="dm-head">
          <div class="dm-logo"><img src="/logo.png" alt="繪新"><span>繪新</span></div>
          <div class="dm-title">${T.name}</div>
          <div class="dm-sub">${T.sub}</div>
        </div>
        <div class="dm-body">
          <div class="dm-tables">
            ${originTable(T, cat, 'kr', '韓國膜（BODAQ / LG）')}
            ${originTable(T, cat, 'jp', '日本膜 PAROI')}
          </div>
          ${notesFor(type, T)}
          <div class="dm-foot">Copyright ${new Date().getFullYear ? '2026' : '2026'} 繪新國際有限公司</div>
        </div>
      </div>`;
  }

  function css() {
    return `
    .dm-sheet{max-width:820px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px -14px rgba(0,0,0,.28);color:var(--dtext);font-family:'Noto Sans TC',system-ui,sans-serif}
    .dm-head{background:linear-gradient(120deg,var(--c1),var(--c2));color:#fff;padding:20px 26px 18px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
    .dm-logo{display:flex;align-items:center;gap:7px;font-weight:900;letter-spacing:2px}
    .dm-logo img{height:26px;width:26px;object-fit:contain;filter:brightness(0) invert(1)}
    .dm-title{font-size:27px;font-weight:900;letter-spacing:3px}
    .dm-sub{font-size:12px;opacity:.9;font-weight:600;letter-spacing:1px}
    .dm-body{padding:20px 26px 8px}
    .dm-tables{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
    .dm-otbl{border:1px solid var(--band);border-radius:12px;overflow:hidden}
    .dm-obrand{background:var(--soft);color:var(--c1);font-weight:900;font-size:15px;padding:9px 14px;letter-spacing:1px}
    .dm-tbl{width:100%;border-collapse:collapse;font-size:14px}
    .dm-tbl th{background:#fff;color:var(--c1);font-weight:800;font-size:13px;padding:8px 6px;text-align:center;border-bottom:1px solid var(--band)}
    .dm-tbl td{padding:10px 8px;text-align:center;border-bottom:1px solid #f0f0f0}
    .dm-tbl tr:last-child td{border-bottom:none}
    .dm-rh{font-weight:700;color:var(--dtext);text-align:left!important;padding-left:14px!important}
    .dm-p{font-weight:900;font-variant-numeric:tabular-nums;background:var(--c1);color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .dm-p2{background:var(--c2)}
    .dm-sech{font-size:16px;font-weight:900;color:#fff;background:var(--accent);display:inline-block;padding:4px 14px;border-radius:7px;letter-spacing:1px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .dm-note{background:var(--soft);border-radius:12px;padding:12px 16px 14px;margin-bottom:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .dm-note-t{font-size:15px;font-weight:900;color:var(--c1);margin-bottom:6px;position:relative;padding-left:12px}
    .dm-note-t::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:4px;border-radius:3px;background:var(--accent)}
    .dm-note-b{font-size:12.5px;line-height:1.75;color:#4a4038}
    .dm-ul,.dm-ol{margin:2px 0;padding-left:20px}
    .dm-ul li,.dm-ol li{margin:2px 0}
    .dm-ul{list-style:disc} .dm-ol{list-style:decimal}
    .dm-note-b b{color:var(--c1)}
    .dm-two{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
    .dm-two .dm-note{margin-bottom:0}
    .dm-fut-row{font-size:12.5px;line-height:1.7}
    .dm-foot{text-align:center;color:#b5aa9c;font-size:11px;padding:10px 0 14px;letter-spacing:1px}
    @media(max-width:640px){.dm-tables,.dm-two{grid-template-columns:1fr}.dm-title{font-size:21px}}
    @media print{.dm-sheet{box-shadow:none;border-radius:0;max-width:100%}}
    `;
  }

  window.DoorSheet = { render, css, TYPES };
})();
