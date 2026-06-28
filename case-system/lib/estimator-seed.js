// 估價計價「價目」原始資料 —— 原封不動移植自同事估價原型（繪新估價原型_互動版.html）
// 用途：第一次啟動時 seed 進 est_films / est_glass / est_doors / est_freight / est_settings。
// ⚠️ 之後價目以「資料表 / 報價設定頁」為準，客服可改；此檔僅為初始值（待客服校正）。

// 膜料（牆面/電梯共用）：每才單價 plane/cabinet/shape；perM=一米價；width=膜寬
const FILMS = {
  krmerge: { label: '韓國膜（LX防焰+Bodaq・現貨綜合）', origin: 'kr', width: 122, items: [
    { sys: '現貨膜（一米1,300以下）', perM: 1350, plane: 160, cabinet: 180, shape: 200 },
    { sys: 'BA／W 木紋', perM: 900, plane: 130, cabinet: 150, shape: 200 },
    { sys: 'BD／XP,DWP 木紋', perM: 1100, plane: 130, cabinet: 150, shape: 200 },
    { sys: 'WG(CW,DW,FW,EW) 木紋', perM: 800, plane: 130, cabinet: 150, shape: 200 },
    { sys: 'WGA(SW),WP(NW,NE) 木紋', perM: 1050, plane: 130, cabinet: 150, shape: 200 },
    { sys: 'AA,SH,BP／NS,RM,TNS,HS,PZN 金屬/石紋/皮革/亮面', perM: 1200, plane: 140, cabinet: 160, shape: 200 },
    { sys: 'AB,BM,AT／PM,SPW,VM 石紋/木紋/金屬', perM: 1300, plane: 140, cabinet: 160, shape: 200 },
    { sys: 'AP／PNC 塗料', perM: 1350, plane: 140, cabinet: 160, shape: 200 },
    { sys: 'WH(BW),MH(PM) 木紋', perM: 1300, plane: 140, cabinet: 160, shape: 200 },
    { sys: 'SG(RS,RE,RSP,ES) 素面', perM: 800, plane: 150, cabinet: 170, shape: 200 },
    { sys: 'SN(NV),ST(SM) 折射光澤', perM: 1100, plane: 150, cabinet: 170, shape: 200 },
    { sys: 'SR(RGM,EGM) 木紋', perM: 900, plane: 150, cabinet: 170, shape: 200 },
    { sys: 'SS／S 素面', perM: 800, plane: 150, cabinet: 170, shape: 200 },
    { sys: 'MG(MS,RP),WN 金屬', perM: 1200, plane: 160, cabinet: 180, shape: 200 },
    { sys: 'ST／SMT 素面', perM: 1050, plane: 160, cabinet: 180, shape: 200 },
    { sys: 'VB(BM) 石紋', perM: 1200, plane: 160, cabinet: 180, shape: 200 },
    { sys: 'VS(ML,RM,MLS) 編織/皮革', perM: 1200, plane: 160, cabinet: 180, shape: 200 },
    { sys: 'WC(PW),VN(NS) 石紋/塗料', perM: 1800, plane: 160, cabinet: 205, shape: 230 },
    { sys: 'VF(SF) 編織', perM: 1500, plane: 180, cabinet: 205, shape: 230 },
    { sys: 'SD(DP) 折射光澤', perM: 1350, plane: 185, cabinet: 200, shape: 200 },
    { sys: 'VE(EL) 塗料/編織', perM: 1600, plane: 185, cabinet: 200, shape: 230 },
    { sys: 'AU／UMI 炫彩', perM: 1500, plane: 260, cabinet: 280, shape: 290 },
    { sys: 'AF／RF 編織', perM: 1600, plane: 270, cabinet: 290, shape: 300 }
  ]},
  paroi_fr: { label: '日本膜 Paroi・耐燃', origin: 'jp', width: 122, items: [
    { sys: '現貨膜（耐燃・一米2,400以下）', perM: 2400, plane: 230, cabinet: 250, shape: 280 },
    { sys: 'BR,MO,PBR,PMO,PNU 素面', perM: 1500, plane: 160, cabinet: 180, shape: 210 },
    { sys: 'PPL 珍珠', perM: 1800, plane: 180, cabinet: 200, shape: 230 },
    { sys: 'LE,ME…WY 木紋/石紋/素面/皮革/抽象/金屬', perM: 2400, plane: 230, cabinet: 250, shape: 280 },
    { sys: 'PKM 亮面', perM: 2600, plane: 240, cabinet: 260, shape: 290 },
    { sys: 'PMS,PWO-E,WMS 亮面/木紋', perM: 2800, plane: 250, cabinet: 270, shape: 300 },
    { sys: 'PGW,WSP,WHG 木紋', perM: 2900, plane: 260, cabinet: 280, shape: 310 },
    { sys: 'JS 金屬', perM: 4200, plane: 350, cabinet: 370, shape: 400 }
  ]},
  paroi_nf: { label: '日本膜 Paroi・不耐燃/戶外', origin: 'jp', width: 122, items: [
    { sys: '現貨膜（不耐燃・一米2,200以下）', perM: 2200, plane: 210, cabinet: 230, shape: 260 },
    { sys: '戶外膜系列（PBR/PNU/PWO）', perM: 3300, plane: 300, cabinet: 300, shape: 300 },
    { sys: 'PS 石膏（寬93cm）', perM: 4300, plane: 400, cabinet: 420, shape: 450 }
  ]},
  rhino: { label: '透明犀牛皮（牆面保護膜）', origin: 'kr', width: 152, flatPrice: true, items: [
    { sys: '透明犀牛皮保護膜', perM: 5911, plane: 350, cabinet: 350, shape: 350 }
  ]}
};

// 玻璃：每才單價分業主/設計師
const GLASS = {
  fog: { label: '霧膜', items: [{ sys: '霧膜', owner: 120, designer: 100 }] },
  rib: { label: '長虹膜', items: [
    { sys: 'DG-1129 雲柔紗背膠和紙', owner: 160, designer: 160 }, { sys: 'L-1507 透明', owner: 160, designer: 160 },
    { sys: 'L-1508 磨砂白', owner: 160, designer: 160 }, { sys: 'L-1509 磨砂茶', owner: 160, designer: 160 },
    { sys: 'L-1510 磨砂灰', owner: 160, designer: 160 }, { sys: 'L-1511 淺灰', owner: 160, designer: 160 },
    { sys: 'L-1521 立體長虹 茶', owner: 160, designer: 160 }, { sys: 'L-1522 立體長虹 灰', owner: 160, designer: 160 },
    { sys: 'L-1525 立體小冰柱', owner: 160, designer: 160 }, { sys: 'L-1526 超白油砂長虹', owner: 160, designer: 160 },
    { sys: 'L-1533 柔霧膜', owner: 160, designer: 160 }, { sys: 'L-1534 白霧膜', owner: 160, designer: 160 },
    { sys: 'L-2502 鏡子膜', owner: 160, designer: 160 }, { sys: 'L-9341 立體長虹', owner: 160, designer: 160 }
  ]},
  heat: { label: '隔熱紙', items: [
    { sys: 'T 系列（含金屬）', owner: 160, designer: 160 }, { sys: 'T 系列（不含金屬）', owner: 180, designer: 180 },
    { sys: 'M 系列', owner: 190, designer: 190 }, { sys: 'X 系列', owner: 250, designer: 250 }
  ]},
  shield: { label: '疏水防爆膜', items: [{ sys: '疏水防爆膜', owner: 450, designer: 400 }] },
  rhino: { label: '透明犀牛皮', items: [{ sys: '透明犀牛皮保護膜', owner: 350, designer: 350 }] }
};

// 門（固定價/座）：一般門 kr/jp × 層數(1/2) × 選項(0/1)；frameOnly 只看品牌價
const DOOR = {
  main:        { label: '大門', kr: { '1': { 0: 10000, 1: 13000 }, '2': { 0: 14000, 1: 19000 } }, jp: { '1': { 0: 10000, 1: 16000 }, '2': { 0: 18000, 1: 25000 } } },
  mother:      { label: '子母門', kr: { '1': { 0: 13000, 1: 16000 }, '2': { 0: 21000, 1: 24000 } }, jp: { '1': { 0: 18000, 1: 21000 }, '2': { 0: 27000, 1: 30000 } } },
  'room-flat': { label: '全平面房門', kr: { '1': { 0: 8000, 1: 10000 }, '2': { 0: 12000, 1: 15000 } }, jp: { '1': { 0: 10000, 1: 15000 }, '2': { 0: 15000, 1: 19500 } } },
  'room-shape':{ label: '造型房門', kr: { '1': { 0: 10000, 1: 12000 }, '2': { 0: 14000, 1: 17000 } }, jp: { '1': { 0: 12000, 1: 17000 }, '2': { 0: 17000, 1: 21500 } } },
  'fire-s':    { label: '單開小座防火門', kr: { '1': { 0: 10000, 1: 15000 }, '2': { 0: 16000, 1: 22500 } }, jp: { '1': { 0: 13000, 1: 18000 }, '2': { 0: 19000, 1: 25000 } } },
  'fire-l':    { label: '單開大座防火門', kr: { '1': { 0: 15000, 1: 20000 }, '2': { 0: 24000, 1: 30000 } }, jp: { '1': { 0: 18000, 1: 23000 }, '2': { 0: 27000, 1: 33000 } } },
  'fire-d':    { label: '雙開防火門', kr: { '1': { 0: 23000, 1: 28000 }, '2': { 0: 42000, 1: 45000 } }, jp: { '1': { 0: 26000, 1: 34000 }, '2': { 0: 48000, 1: 51000 } } },
  'frame-12':  { label: '單貼門框-1~2層框', frameOnly: 1, kr: 8000, jp: 10000 },
  'frame-3':   { label: '單貼門框-3層框', frameOnly: 1, kr: 10000, jp: 12000 },
  'frame-cx':  { label: '單貼門框-複雜框', frameOnly: 1, kr: 12000, jp: 14000 }
};

// 車馬費 4 欄（真實牌價 2026.03~04，權威來源 ~/Desktop/價目表/）：
//   survey_fee=場勘車馬費（案件成交可折抵；超過案件金額此項可免收）、amount=施工車馬費、
//   overnight_fee=過夜住宿/一組工每晚、night_surcharge=夜間施工加價（X 以 0 記）
const FREIGHT = {
  '北北桃':   { survey_fee: 1000, amount: 0,     overnight_fee: 0,     night_surcharge: 10000 },
  '竹基':     { survey_fee: 1500, amount: 1500,  overnight_fee: 0,     night_surcharge: 10000 },
  '苗中彰':   { survey_fee: 2000, amount: 4000,  overnight_fee: 10000, night_surcharge: 0 },
  '宜蘭':     { survey_fee: 2000, amount: 4000,  overnight_fee: 10000, night_surcharge: 0 },
  '雲嘉投':   { survey_fee: 4000, amount: 6000,  overnight_fee: 12000, night_surcharge: 0 },
  '花蓮':     { survey_fee: 5000, amount: 7000,  overnight_fee: 13000, night_surcharge: 0 },
  '南高':     { survey_fee: 6000, amount: 8000,  overnight_fee: 14000, night_surcharge: 0 },
  '屏東台東': { survey_fee: 8000, amount: 10000, overnight_fee: 16000, night_surcharge: 0 },
};
const LOWMIN = { owner: 10000, designer: 9000 };

module.exports = { FILMS, GLASS, DOOR, FREIGHT, LOWMIN };
