// 估價計價「真實牌價」資料 —— 取自繪新真實七張價目表（2026.03~04，~/Desktop/價目表/）。
// 結構：裝潢膜三品牌(Bodaq/BENIF/PAROI)，每系列一列，三種連工帶料每才價：plane牆面/cabinet系統櫃/shape造型。
// ⚠️ 防焰/不防焰「不分」：同系列連工帶料價相同（防焰只差每米材料成本＝機密，估價不顯示）。model＝型號(客服備註·非必填)。
// 門：大門現貨/房門現貨/防火門三類。膜寬預設122cm(PS石膏93)。之後以「報價設定」後台(est_*_catalog 表)為準；此為初始 seed 值，Flora 校正。

// ── 裝潢膜（才數制；才＝寬×高÷900；一系列一列）──────────────────
const FILMS = {
  bodaq: { label: 'Bodaq', items: [
    { asia: 'SS', kr: 'S', color: '素面', model: '', plane: 150, cabinet: 170, shape: 200 },
    { asia: 'BA', kr: 'W', color: '木紋', model: '', plane: 130, cabinet: 150, shape: 200 },
    { asia: 'ST', kr: 'SMT', color: '素面', model: '', plane: 160, cabinet: 180, shape: 200 },
    { asia: 'BD', kr: 'XP,DWP', color: '木紋', model: '', plane: 130, cabinet: 150, shape: 200 },
    { asia: 'AA,SH,BP', kr: 'NS,RM,TNS,HS,PZN', color: '金屬/石紋/皮革/亮面', model: '', plane: 140, cabinet: 160, shape: 200 },
    { asia: 'AB,BM,AT', kr: 'PM,SPW,VM', color: '石紋/木紋/金屬', model: '', plane: 140, cabinet: 160, shape: 200 },
    { asia: 'AP', kr: 'PNC', color: '塗料', model: '', plane: 140, cabinet: 160, shape: 200 },
    { asia: 'AU', kr: 'UMI', color: '炫彩', model: '', plane: 260, cabinet: 280, shape: 290 },
    { asia: 'AF', kr: 'RF', color: '編織', model: '', plane: 270, cabinet: 290, shape: 300 },
  ] },
  benif: { label: 'BENIF', items: [
    { asia: 'WG', kr: 'CW,DW,FW,EW', color: '木紋', model: '', plane: 130, cabinet: 150, shape: 200 },
    { asia: 'WGA,WP', kr: 'SW,NW,NE', color: '木紋', model: '', plane: 130, cabinet: 150, shape: 200 },
    { asia: 'SR', kr: 'RGM,EGM', color: '木紋', model: '', plane: 150, cabinet: 170, shape: 200 },
    { asia: 'SG', kr: 'RS,RE,RSP,ES', color: '素面', model: '', plane: 150, cabinet: 170, shape: 200 },
    { asia: 'SN,ST', kr: 'NV,SM', color: '折射光澤', model: '', plane: 160, cabinet: 180, shape: 200 },
    { asia: 'MG,WN', kr: 'MS,RP', color: '金屬', model: '', plane: 160, cabinet: 180, shape: 200 },
    { asia: 'VS', kr: 'ML,RM,MLS', color: '編織/皮革', model: '', plane: 160, cabinet: 180, shape: 200 },
    { asia: 'VB', kr: 'BM', color: '石紋', model: '', plane: 160, cabinet: 180, shape: 200 },
    { asia: 'WH,MH', kr: 'BW,PM', color: '木紋', model: '', plane: 140, cabinet: 160, shape: 200 },
    { asia: 'SD', kr: 'DP', color: '折射光澤', model: '', plane: 185, cabinet: 200, shape: 200 },
    { asia: 'VF', kr: 'SF', color: '編織', model: '', plane: 180, cabinet: 205, shape: 230 },
    { asia: 'VE', kr: 'EL', color: '塗料/編織', model: '', plane: 185, cabinet: 200, shape: 230 },
    { asia: 'WC,VN', kr: 'PW,NS', color: '石紋/塗料', model: '', plane: 160, cabinet: 205, shape: 230 },
  ] },
  paroi: { label: 'PAROI', items: [
    { asia: 'BR,MO,PBR,PMO,PNU', kr: '', color: '素面', model: '', plane: 160, cabinet: 180, shape: 210 },
    { asia: 'PPL', kr: '', color: '珍珠', model: '', plane: 180, cabinet: 200, shape: 230 },
    { asia: 'LE,ME,MES,PCO,PFM…', kr: '', color: '木紋/石紋/素面/皮革/抽象/金屬', model: '', plane: 230, cabinet: 250, shape: 280 },
    { asia: 'PKM', kr: '', color: '亮面', model: '', plane: 240, cabinet: 260, shape: 290 },
    { asia: 'PMS,PWO-E,WMS', kr: '', color: '亮面/木紋', model: '', plane: 250, cabinet: 270, shape: 300 },
    { asia: 'PGW,WSP,WHG', kr: '', color: '木紋', model: '', plane: 260, cabinet: 280, shape: 310 },
    { asia: 'JS', kr: '', color: '金屬', model: '', plane: 350, cabinet: 370, shape: 400 },
    { asia: 'PBR-E,PNU-E', kr: '', color: '素面/木紋（戶外膜）', model: '', plane: 210, cabinet: 230, shape: 260 },
    { asia: 'PS', kr: '', color: '石膏（寬930·20米/捲）', model: '', plane: 400, cabinet: 420, shape: 450, width: 93 },
  ] },
};

// ── 玻璃（沿用同事；價目表未涵蓋）：每才單價分業主/設計師 ──────────
const GLASS = {
  fog: { label: '霧膜', items: [{ sys: '霧膜', owner: 120, designer: 100 }] },
  rib: { label: '長虹膜', items: [
    { sys: 'DG-1129 雲柔紗背膠和紙', owner: 160, designer: 160 }, { sys: 'L-1507 透明', owner: 160, designer: 160 },
    { sys: 'L-1508 磨砂白', owner: 160, designer: 160 }, { sys: 'L-1509 磨砂茶', owner: 160, designer: 160 },
    { sys: 'L-1510 磨砂灰', owner: 160, designer: 160 }, { sys: 'L-1511 淺灰', owner: 160, designer: 160 },
    { sys: 'L-1521 立體長虹 茶', owner: 160, designer: 160 }, { sys: 'L-1522 立體長虹 灰', owner: 160, designer: 160 },
    { sys: 'L-1525 立體小冰柱', owner: 160, designer: 160 }, { sys: 'L-1526 超白油砂長虹', owner: 160, designer: 160 },
    { sys: 'L-1533 柔霧膜', owner: 160, designer: 160 }, { sys: 'L-1534 白霧膜', owner: 160, designer: 160 },
    { sys: 'L-2502 鏡子膜', owner: 160, designer: 160 }, { sys: 'L-9341 立體長虹', owner: 160, designer: 160 },
  ] },
  heat: { label: '隔熱紙', items: [
    { sys: 'T 系列（含金屬）', owner: 160, designer: 160 }, { sys: 'T 系列（不含金屬）', owner: 180, designer: 180 },
    { sys: 'M 系列', owner: 190, designer: 190 }, { sys: 'X 系列', owner: 250, designer: 250 },
  ] },
  shield: { label: '疏水防爆膜', items: [{ sys: '疏水防爆膜', owner: 450, designer: 400 }] },
  rhino: { label: '透明犀牛皮', items: [{ sys: '透明犀牛皮保護膜', owner: 350, designer: 350 }] },
};

// ── 門（固定價/座）：大門/房門現貨 韓日×單雙面×不含/含框；防火門 小座/大座/雙開×韓日×單雙面(含框) ──
const DOORS = {
  main: { label: '大門現貨',
    kr: { single: { no: 10000, yes: 13000 }, double: { no: 14000, yes: 19000 } },
    jp: { single: { no: 10000, yes: 16000 }, double: { no: 18000, yes: 25000 } } },
  room: { label: '房門現貨',
    kr: { single: { no: 10000, yes: 10000 }, double: { no: 12000, yes: 15000 } },
    jp: { single: { no: 10000, yes: 15000 }, double: { no: 15000, yes: 19500 } } },
  fire: { label: '防火門', sized: 1,
    small: { label: '單開小座', kr: { single: 15000, double: 22500 }, jp: { single: 18000, double: 25000 } },
    large: { label: '單開大座', kr: { single: 20000, double: 30000 }, jp: { single: 23000, double: 33000 } },
    double: { label: '雙開', kr: { single: 28000, double: 45000 }, jp: { single: 34000, double: 51000 } } },
};

// ── 車馬費（施工）依區域；低消；期貨運費 ───────────────────────────
const FREIGHT = { '北北桃': 0, '竹基': 1500, '苗中彰': 4000, '宜蘭': 4000, '雲嘉投': 6000, '花蓮': 7000, '南高': 8000, '屏東台東': 10000 };
const LOWMIN = { owner: 10000, designer: 9000 };
// 期貨運費（裝潢膜）：韓國膜 海運3000/空運6000；日本膜 統一空運6000。含出貨時間（不含假日）
const FUT = {
  kr: { label: '韓國膜', methods: [{ v: 'sea', name: '海運', price: 3000, lead: '20～30 工作天' }, { v: 'air', name: '空運', price: 6000, lead: '2～10 工作天' }] },
  jp: { label: '日本膜', methods: [{ v: 'air', name: '空運', price: 6000, lead: '約 3～4 週' }] },
};

module.exports = { FILMS, GLASS, DOORS, FREIGHT, LOWMIN, FUT };
