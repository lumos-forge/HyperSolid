// Full HyperSolid app screen set in the ACCEPTED professional design language
// (light, internationalized) matching marketdetail.png. Renders the 5 bottom-tab
// screens: 行情 / 交易 / 持仓 / 策略 / 钱包.
//   node render-core.js screens.html screens.png
const fs = require('fs');

const T = {
  bg: '#FFFFFF', surf: '#F5F7FA', surf2: '#FBFCFD', line: '#EDF0F4', line2: '#E4E8EE',
  text: '#0B0F14', dim: '#8B95A1', sub: '#AEB6C0', up: '#16C784', down: '#F0616A',
  star: '#F5A623', cta: '#0B0E13', ctaText: '#FFFFFF', pill: '#EEF1F5', brand: '#0B0E13',
  upbg: 'rgba(22,199,132,.10)', downbg: 'rgba(240,97,106,.10)',
};

function svg(inner, size, sw, fill) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill || 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="${sw || 1.8}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${inner}</svg>`;
}
const ICON = {
  markets: (a) => `<polyline points="2,14 6,14 8.5,8 11,17 13.5,6 16,14 22,14"/>${a ? '<circle cx="13.5" cy="6" r="1.7" fill="currentColor" stroke="none"/>' : ''}`,
  trade: () => `<path d="M8 20V5"/><path d="M4.5 8.5 8 5l3.5 3.5"/><path d="M16 4v15"/><path d="M12.5 15.5 16 19l3.5-3.5"/>`,
  positions: () => `<path d="M12 3 21 8 12 13 3 8Z"/><path d="M3 12.5 12 17.5 21 12.5"/>`,
  agent: (a) => `<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6" ${a ? 'fill="currentColor" stroke="none"' : ''}/><path d="M12 1.5V4.5"/><path d="M12 19.5V22.5"/><path d="M1.5 12H4.5"/><path d="M19.5 12H22.5"/>`,
  account: () => `<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>`,
  star: () => `<path d="M12 3.2 14.7 9l6.3.7-4.7 4.3 1.3 6.2L12 17.1 6.4 20.2l1.3-6.2L3 9.7 9.3 9Z"/>`,
  search: () => `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20 15.5 15.5"/>`,
  caret: () => `<path d="M6 9l6 6 6-6"/>`,
  shield: () => `<path d="M12 3 19 6v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6Z"/><path d="M9 12l2 2 4-4"/>`,
  bolt: () => `<path d="M13 2 5 13h6l-1 9 8-12h-6z"/>`,
  globe: () => `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>`,
  chevR: () => `<path d="M9 6l6 6-6 6"/>`,
  plus: () => `<path d="M12 5v14M5 12h14"/>`,
  wallet: () => `<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12h3"/>`,
};
function ico(name, px, color, a, sw, fill) {
  return `<span style="color:${color};display:inline-flex">${svg(ICON[name](a), px, sw, fill)}</span>`;
}

const NAV = [['markets', '行情'], ['trade', '交易'], ['positions', '持仓'], ['agent', '策略'], ['account', '钱包']];
function statusbar() {
  return `<div class="status"><span class="t">20:12</span><span class="si">●●●● ▾ ▮</span></div>`;
}
function header(title, right) {
  return `<div class="hd"><span class="wm">${title}</span>${right || ''}</div>`;
}
function pill(txt) { return `<span class="npill">${txt}</span>`; }
function tabbar(active) {
  return `<div class="tabbar">${NAV.map(([k, l]) => {
    const on = k === active;
    return `<div class="tcell">${ico(k, 22, on ? T.text : T.dim, on, 1.8)}<div class="tlbl" style="color:${on ? T.text : T.dim};font-weight:${on ? 700 : 600}">${l}</div></div>`;
  }).join('')}</div>`;
}
function spark(up, seed) {
  let d = 'M0 18'; const n = 20;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * 70;
    const y = 18 - (Math.sin(i * 0.7 + seed) * 5 + Math.sin(i * 0.3 + seed) * 4 + (up ? i * 0.25 : -i * 0.25));
    d += ` L${x.toFixed(1)} ${Math.max(2, Math.min(34, y)).toFixed(1)}`;
  }
  return `<svg width="70" height="36" viewBox="0 0 70 36"><path d="${d}" fill="none" stroke="${up ? T.up : T.down}" stroke-width="1.6"/></svg>`;
}

// ---------------- screens ----------------
const coins = [
  ['BTC', '64,731.5', 1.09, 1, '1.77B'], ['ETH', '3,002.18', -0.86, 0, '842M'],
  ['SOL', '148.22', 5.41, 1, '510M'], ['HYPE', '28.74', 1.07, 1, '333M'],
  ['ARB', '1.1820', -2.30, 0, '119M'], ['DOGE', '0.16420', 0.92, 1, '97M'],
];
function markets() {
  const rows = coins.map((c, i) => {
    const col = c[3] ? T.up : T.down, s = c[2] >= 0 ? '+' : '';
    return `<div class="mrow">
      <div class="mleft">${ico('star', 16, (i < 2 || i === 3) ? T.star : T.sub, 0, 0, (i < 2 || i === 3) ? T.star : 'none')}
        <div><div class="tk">${c[0]}<span class="perp">PERP</span></div><div class="sub">Vol ${c[4]}</div></div></div>
      <div class="spk">${spark(c[3], i)}</div>
      <div class="mpx"><div class="big">${c[1]}</div><span class="chgb" style="color:${col};background:${c[3] ? T.upbg : T.downbg}">${s}${c[2].toFixed(2)}%</span></div></div>`;
  }).join('');
  return `${statusbar()}${header('HYPERSOLID', `<span class="hr">${pill('TESTNET')}${ico('search', 20, T.dim, 0, 1.9)}</span>`)}
    <div class="pad">
      <div class="h1">行情 <span class="en">Markets</span></div>
      <div class="seg">${['合约', '现货', '自选'].map((s, i) => `<span class="segc ${i === 0 ? 'on' : ''}">${s}</span>`).join('')}</div>
      <div class="colhd"><span>名称 / 成交量</span><span>趋势</span><span>最新价 / 涨跌</span></div>
      <div class="mlist">${rows}</div>
    </div>`;
}

function trade() {
  return `${statusbar()}${header('交易 <span class="en2">Trade</span>', pill('TESTNET'))}
    <div class="pad">
      <div class="pairbar"><span class="pair">BTC-USDC <span class="perp">PERP</span> ${ico('caret', 13, T.dim, 0, 2)}</span>
        <span class="pairpx">64,731.5 <span style="color:${T.up}">+1.09%</span></span></div>
      <div class="bs">
        <button class="bbtn buy">买入 / 做多</button>
        <button class="bbtn sell">卖出 / 做空</button></div>
      <div class="otype">${['限价', '市价', '条件'].map((s, i) => `<span class="ot ${i === 0 ? 'on' : ''}">${s}</span>`).join('')}<span class="lev">20× 逐仓 ${ico('caret', 12, T.dim, 0, 2)}</span></div>
      <div class="field"><span class="fl">价格 (USDC)</span><span class="fv">64,731.5</span></div>
      <div class="field"><span class="fl">数量 (BTC)</span><span class="fv ph">0.00</span></div>
      <div class="slider"><div class="track"><div class="fill" style="width:50%"></div><div class="knob" style="left:50%"></div></div>
        <div class="ticks">${['0', '25%', '50%', '75%', '100%'].map((x) => `<span>${x}</span>`).join('')}</div></div>
      <div class="sum">
        <div class="sr"><span>可用</span><span>1,284.20 USDC</span></div>
        <div class="sr"><span>保证金</span><span>≈ 161.83 USDC</span></div>
        <div class="sr"><span>预计强平价</span><span>61,402.0</span></div></div>
      <button class="cta buyc">买入 / 做多 BTC</button>
    </div>`;
}

function positions() {
  const ps = [
    ['BTC', 'long', '0.124', '20×', '61,240', '64,731', '+432.10', 1],
    ['ETH', 'short', '2.50', '10×', '3,110', '3,002', '+268.40', 1],
    ['SOL', 'long', '18.0', '5×', '151.20', '148.22', '-53.64', 0],
  ];
  const rows = ps.map((p) => `<div class="pcard">
    <div class="ph"><span class="pcoin">${p[0]}<span class="perp">PERP</span></span>
      <span class="ptag ${p[1]}">${p[1] === 'long' ? '多' : '空'} · ${p[3]}</span>
      <span class="ppnl" style="color:${p[7] ? T.up : T.down}">${p[6]} USDC</span></div>
    <div class="pg">
      <div><div class="gl">数量</div><div class="gv">${p[2]}</div></div>
      <div><div class="gl">开仓价</div><div class="gv">${p[4]}</div></div>
      <div><div class="gl">标记价</div><div class="gv">${p[5]}</div></div>
      <div><div class="gl">回报率</div><div class="gv" style="color:${p[7] ? T.up : T.down}">${p[7] ? '+' : ''}${(parseFloat(p[6].replace(',', '')) / 160).toFixed(1)}%</div></div>
    </div></div>`).join('');
  return `${statusbar()}${header('持仓 <span class="en2">Positions</span>', pill('TESTNET'))}
    <div class="pad">
      <div class="acct"><div class="ac"><div class="al">账户权益 (USDC)</div><div class="av">12,840.55</div></div>
        <div class="acr"><div><div class="al2">可用</div><div class="av2">1,284.20</div></div>
        <div><div class="al2">未实现盈亏</div><div class="av2" style="color:${T.up}">+646.86</div></div></div></div>
      <div class="seg">${['持仓 3', '挂单 2', '历史'].map((s, i) => `<span class="segc ${i === 0 ? 'on' : ''}">${s}</span>`).join('')}</div>
      <div class="plist">${rows}</div>
    </div>`;
}

function agent() {
  const cards = [
    ['网格策略', 'BTC-USDC · 运行中', '+5.82%', 1, 'bolt'],
    ['定投 DCA', 'ETH · 每周一', '+1.24%', 1, 'agent'],
  ];
  const rows = cards.map((c) => `<div class="scard">
    <div class="sicon">${ico(c[4], 20, T.text, 1, 1.8)}</div>
    <div class="smid"><div class="sname">${c[0]}</div><div class="sdesc">${c[1]}</div></div>
    <div class="sret" style="color:${T.up}">${c[2]}</div>${ico('chevR', 16, T.sub, 0, 2)}</div>`).join('');
  return `${statusbar()}${header('策略 <span class="en2">Agent</span>', pill('TESTNET'))}
    <div class="pad">
      <div class="hero"><div class="herol">本月策略收益</div><div class="herov" style="color:${T.up}">+7.06%</div>
        <div class="herosub">2 个运行中 · 风险敞口受控</div></div>
      <div class="seclbl">我的策略</div>
      <div class="slist">${rows}</div>
      <button class="cta ghost">${ico('plus', 16, T.text, 0, 2)} 创建新策略</button>
    </div>`;
}

function account() {
  const items = [
    ['shield', '安全与生物识别', 'Face ID 已启用'],
    ['globe', '网络', 'Testnet'],
    ['bolt', '主题', '浅色'],
    ['wallet', '导出 / 备份', ''],
  ];
  const rows = items.map((it) => `<div class="arow"><span class="ai">${ico(it[0], 19, T.text, 0, 1.8)}</span>
    <span class="aname">${it[1]}</span><span class="aval">${it[2]}</span>${ico('chevR', 15, T.sub, 0, 2)}</div>`).join('');
  return `${statusbar()}${header('钱包 <span class="en2">Account</span>', pill('TESTNET'))}
    <div class="pad">
      <div class="wcard"><div class="wtop"><span class="wlbl">本地钱包</span><span class="wbadge">非托管</span></div>
        <div class="waddr">0x7a3f…9C42</div>
        <div class="wbal"><span>余额</span><b>12,840.55 USDC</b></div></div>
      <div class="alist">${rows}</div>
      <button class="cta ghost">${ico('wallet', 16, T.text, 0, 1.8)} 管理钱包</button>
    </div>`;
}

const SCREENS = [['markets', '行情 MARKETS', markets], ['trade', '交易 TRADE', trade], ['positions', '持仓 POSITIONS', positions], ['agent', '策略 AGENT', agent], ['account', '钱包 ACCOUNT', account]];

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#06070A}
.stage{width:2160px;padding:46px;background:radial-gradient(120% 70% at 50% 0,#0E1218 0,#06070A 60%);font-family:-apple-system,"SF Pro Display",Inter,system-ui,sans-serif}
.title{font:800 28px Inter,sans-serif;color:#EAF0F4}
.subtitle{font:500 14px Inter,sans-serif;color:#76828C;margin:8px 0 30px}
.row{display:flex;gap:30px}
.col{display:flex;flex-direction:column;gap:12px;align-items:center}
.clabel{font:800 12px Inter,sans-serif;color:#C7D0D8;letter-spacing:1px}
.phone{width:372px;background:${T.bg};border-radius:30px;overflow:hidden;border:1px solid ${T.line2};box-shadow:0 26px 60px rgba(0,0,0,.45);position:relative}
.screen{position:relative;padding-bottom:78px;min-height:780px}
.status{display:flex;justify-content:space-between;align-items:center;padding:12px 20px 2px}
.status .t{font:700 15px ui-monospace,"SF Mono",monospace;color:${T.text}}
.status .si{font:600 11px sans-serif;color:${T.dim};letter-spacing:1px}
.hd{display:flex;align-items:center;justify-content:space-between;padding:10px 20px 4px}
.wm{font:800 18px sans-serif;color:${T.text};letter-spacing:.4px}
.en2{color:${T.dim};font-weight:600;font-size:13px}
.hr{display:flex;align-items:center;gap:12px}
.npill{font:700 9.5px sans-serif;letter-spacing:.8px;color:${T.dim};background:${T.pill};border-radius:7px;padding:4px 8px}
.pad{padding:10px 20px 0}
.h1{font:800 24px sans-serif;color:${T.text};margin:6px 0 14px}
.en{color:${T.dim};font-weight:600;font-size:15px}
.seg{display:flex;gap:8px;margin-bottom:14px}
.segc{font:600 13px sans-serif;color:${T.dim};background:${T.surf};border-radius:9px;padding:7px 15px}
.segc.on{color:#fff;background:${T.brand};font-weight:700}
.colhd{display:flex;justify-content:space-between;padding:0 2px 8px;border-bottom:1px solid ${T.line}}
.colhd span{font:500 11px sans-serif;color:${T.dim}}
.colhd span:nth-child(2){flex:0 0 70px;text-align:center}
.colhd span:nth-child(3){text-align:right}
.mrow{display:flex;align-items:center;justify-content:space-between;padding:13px 2px;border-bottom:1px solid ${T.line}}
.mleft{display:flex;align-items:center;gap:11px;flex:1}
.tk{font:700 15.5px sans-serif;color:${T.text};display:flex;align-items:center;gap:6px}
.perp{font:700 8px sans-serif;letter-spacing:.4px;color:${T.dim};border:1px solid ${T.line2};border-radius:4px;padding:1px 4px}
.sub{font:500 11px sans-serif;color:${T.dim};margin-top:3px}
.spk{flex:0 0 70px;display:flex;justify-content:center}
.mpx{text-align:right;flex:1}
.big{font:600 15px ui-monospace,"SF Mono",monospace;color:${T.text}}
.chgb{display:inline-block;font:700 11.5px ui-monospace,monospace;border-radius:7px;padding:3px 8px;margin-top:5px}
/* trade */
.pairbar{display:flex;justify-content:space-between;align-items:center;background:${T.surf};border-radius:12px;padding:12px 14px;margin-bottom:14px}
.pair{font:800 16px sans-serif;color:${T.text};display:flex;align-items:center;gap:7px}
.pairpx{font:700 14px ui-monospace,monospace;color:${T.text}}
.bs{display:flex;gap:10px;margin-bottom:14px}
.bbtn{flex:1;border:none;border-radius:11px;padding:13px;font:800 14px sans-serif;cursor:pointer}
.bbtn.buy{background:${T.upbg};color:${T.up}}
.bbtn.sell{background:${T.surf};color:${T.dim}}
.otype{display:flex;align-items:center;gap:16px;margin-bottom:14px}
.ot{font:600 13px sans-serif;color:${T.dim}}
.ot.on{color:${T.text};font-weight:800}
.lev{margin-left:auto;font:600 12px sans-serif;color:${T.text};background:${T.surf};border-radius:8px;padding:5px 10px;display:flex;align-items:center;gap:4px}
.field{display:flex;justify-content:space-between;align-items:center;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:14px;margin-bottom:10px}
.fl{font:500 12.5px sans-serif;color:${T.dim}}
.fv{font:700 16px ui-monospace,monospace;color:${T.text}}
.fv.ph{color:${T.sub}}
.slider{margin:8px 2px 16px}
.track{position:relative;height:5px;background:${T.line2};border-radius:3px}
.fill{position:absolute;left:0;top:0;bottom:0;background:${T.brand};border-radius:3px}
.knob{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:${T.brand};transform:translate(-50%,-50%);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.ticks{display:flex;justify-content:space-between;margin-top:10px}
.ticks span{font:600 10.5px ui-monospace,monospace;color:${T.dim}}
.sum{background:${T.surf2};border:1px solid ${T.line};border-radius:12px;padding:12px 14px;margin-bottom:16px}
.sr{display:flex;justify-content:space-between;padding:4px 0;font:500 12.5px sans-serif;color:${T.dim}}
.sr span:last-child{color:${T.text};font-weight:600;font-family:ui-monospace,monospace}
/* positions */
.acct{background:${T.brand};border-radius:16px;padding:16px;margin-bottom:14px;color:#fff}
.al{font:500 11px sans-serif;opacity:.7;margin-bottom:4px}
.av{font:800 26px ui-monospace,monospace;letter-spacing:-.5px}
.acr{display:flex;gap:30px;margin-top:14px}
.al2{font:500 10px sans-serif;opacity:.7;margin-bottom:3px}
.av2{font:700 14px ui-monospace,monospace}
.pcard{background:${T.surf2};border:1px solid ${T.line};border-radius:14px;padding:13px;margin-bottom:10px}
.ph{display:flex;align-items:center;gap:10px;margin-bottom:11px}
.pcoin{font:800 15px sans-serif;color:${T.text};display:flex;align-items:center;gap:5px}
.ptag{font:700 11px sans-serif;border-radius:6px;padding:2px 8px}
.ptag.long{color:${T.up};background:${T.upbg}}
.ptag.short{color:${T.down};background:${T.downbg}}
.ppnl{margin-left:auto;font:800 15px ui-monospace,monospace}
.pg{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px}
.gl{font:500 10px sans-serif;color:${T.dim};margin-bottom:3px}
.gv{font:700 12.5px ui-monospace,monospace;color:${T.text}}
/* agent */
.hero{background:${T.brand};border-radius:16px;padding:18px;color:#fff;margin-bottom:18px}
.herol{font:500 12px sans-serif;opacity:.7}
.herov{font:800 32px ui-monospace,monospace;margin:4px 0;letter-spacing:-1px}
.herosub{font:500 12px sans-serif;opacity:.7}
.seclbl{font:700 13px sans-serif;color:${T.text};margin-bottom:10px}
.scard{display:flex;align-items:center;gap:12px;background:${T.surf2};border:1px solid ${T.line};border-radius:14px;padding:14px;margin-bottom:10px}
.sicon{width:40px;height:40px;border-radius:11px;background:${T.surf};display:flex;align-items:center;justify-content:center}
.smid{flex:1}
.sname{font:700 14.5px sans-serif;color:${T.text}}
.sdesc{font:500 11.5px sans-serif;color:${T.dim};margin-top:3px}
.sret{font:800 15px ui-monospace,monospace;margin-right:6px}
/* account */
.wcard{background:${T.brand};border-radius:16px;padding:18px;color:#fff;margin-bottom:16px}
.wtop{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.wlbl{font:600 13px sans-serif;opacity:.85}
.wbadge{font:700 10px sans-serif;background:rgba(255,255,255,.16);border-radius:6px;padding:3px 8px}
.waddr{font:700 18px ui-monospace,monospace;letter-spacing:.5px;margin-bottom:14px}
.wbal{display:flex;justify-content:space-between;align-items:baseline;font:500 12px sans-serif;opacity:.85}
.wbal b{font:800 17px ui-monospace,monospace;opacity:1}
.arow{display:flex;align-items:center;gap:13px;padding:15px 4px;border-bottom:1px solid ${T.line}}
.ai{width:34px;height:34px;border-radius:10px;background:${T.surf};display:flex;align-items:center;justify-content:center}
.aname{font:600 14px sans-serif;color:${T.text};flex:1}
.aval{font:500 12.5px sans-serif;color:${T.dim}}
/* cta + tabbar */
.cta{position:absolute;left:20px;right:20px;bottom:88px;border:none;border-radius:14px;padding:16px;font:800 15px sans-serif;color:${T.ctaText};background:${T.cta};cursor:pointer}
.cta.buyc{background:${T.up};color:#fff}
.cta.ghost{background:${T.surf};color:${T.text};border:1px solid ${T.line2};display:flex;align-items:center;justify-content:center;gap:7px}
.tabbar{position:absolute;left:0;right:0;bottom:0;display:flex;border-top:1px solid ${T.line};background:${T.surf2};padding:9px 0 12px}
.tcell{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
.tlbl{font-size:10px;font-family:sans-serif}
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="stage">
  <div class="title">HYPERSOLID — 全屏重设计 v1（采纳的专业浅色语言，对齐 marketdetail）</div>
  <div class="subtitle">5 个底部 Tab 屏 · 国际化排版 · 与已采纳的 Market Detail 同一设计语言（配色/字体/圆角/绿涨红跌/黑色主 CTA）· 深色由主题系统支持</div>
  <div class="row">${SCREENS.map(([k, lab, fn]) => `<div class="col"><div class="clabel">${lab}</div><div class="phone"><div class="screen">${fn()}${tabbar(k)}</div></div></div>`).join('')}</div>
</div></body></html>`;

fs.writeFileSync(__dirname + '/screens.html', html);
console.log('wrote screens.html');
