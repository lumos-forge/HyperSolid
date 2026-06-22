// Renders 3 candidate REDESIGN directions for HyperSolid, each showing the two
// most representative screens (Markets + Market Detail) so look/feel/density can
// be compared against mainstream exchange apps.
//   node render-core.js redesign.html redesign.png
const fs = require('fs');

function svg(inner, size, sw) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw || 1.7}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${inner}</svg>`;
}
const ICON = {
  markets: (a) => `<polyline points="2,14 6,14 8.5,8 11,17 13.5,6 16,14 22,14"/>${a ? '<circle cx="13.5" cy="6" r="1.7" fill="currentColor" stroke="none"/>' : ''}`,
  trade: () => `<path d="M8 20V5"/><path d="M4.5 8.5 8 5l3.5 3.5"/><path d="M16 4v15"/><path d="M12.5 15.5 16 19l3.5-3.5"/>`,
  positions: () => `<path d="M12 3 21 8 12 13 3 8Z"/><path d="M3 12.5 12 17.5 21 12.5"/>`,
  agent: (a) => `<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6" ${a ? 'fill="currentColor" stroke="none"' : ''}/><path d="M12 1.5V4.5"/><path d="M12 19.5V22.5"/><path d="M1.5 12H4.5"/><path d="M19.5 12H22.5"/>`,
  account: () => `<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>`,
  star: (a) => `<path d="M12 3.6 14.55 9.1 20.6 9.8 16.1 14 17.4 20 12 16.9 6.6 20 7.9 14 3.4 9.8 9.45 9.1Z" ${a ? 'fill="currentColor"' : ''}/>`,
  chevron: () => `<path d="M14.5 6 9 12l5.5 6"/>`,
  search: () => `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20 15.5 15.5"/>`,
};
function ico(name, px, color, active, sw) {
  return `<span style="color:${color};display:inline-flex;flex:0 0 auto">${svg(ICON[name](active), px, sw)}</span>`;
}

const NAV = [['markets', '行情'], ['trade', '交易'], ['positions', '持仓'], ['agent', '策略'], ['account', '钱包']];
const coins = [
  ['BTC', '62,481.5', 2.14, 1, '0.011%', '1.2B'],
  ['ETH', '3,002.18', -0.86, 0, '0.008%', '842M'],
  ['SOL', '148.22', 5.41, 1, '0.021%', '510M'],
  ['HYPE', '28.74', 1.07, 1, '0.014%', '333M'],
  ['ARB', '1.182', -2.30, 0, '0.006%', '119M'],
  ['DOGE', '0.1642', 0.92, 1, '0.004%', '97M'],
];

function candles(seed, n) {
  let p = 60000, out = [];
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i * 0.5 + seed) * 380 + Math.sin(i * 0.21 + seed * 2) * 220;
    const o = p, c = o + drift + Math.sin(i * 1.7 + seed) * 160;
    const hi = Math.max(o, c) + Math.abs(Math.sin(i * 2.3 + seed)) * 160 + 60;
    const lo = Math.min(o, c) - Math.abs(Math.cos(i * 1.9 + seed)) * 160 - 60;
    out.push([o, c, hi, lo]); p = c;
  }
  return out;
}
function chartSvg(th, w, h) {
  const cs = candles(0.4, 26);
  let max = -1e9, min = 1e9;
  cs.forEach(([o, c, hi, lo]) => { max = Math.max(max, hi); min = Math.min(min, lo); });
  const pad = (max - min) * 0.08; max += pad; min -= pad;
  const y = (v) => h - ((v - min) / (max - min)) * h;
  const cw = w / cs.length;
  let body = '';
  cs.forEach(([o, c, hi, lo], i) => {
    const x = i * cw + cw / 2, up = c >= o, col = up ? th.up : th.down;
    const top = y(Math.max(o, c)), bot = y(Math.min(o, c));
    body += `<line x1="${x.toFixed(1)}" y1="${y(hi).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    body += `<rect x="${(x - cw * 0.3).toFixed(1)}" y="${top.toFixed(1)}" width="${(cw * 0.6).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}" rx="${th.candleRound || 0}"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${body}</svg>`;
}

function statusbar() {
  return `<div class="sb">
    <span class="sb-time">9:41</span>
    <span class="sb-wm">HYPERSOLID</span>
    <span class="pill">TESTNET</span></div>`;
}
function tabbar(th, S, active) {
  const cells = NAV.map(([k, label]) => {
    const on = k === active;
    return `<div class="tcell">${ico(k, 21, on ? th.brand : th.dim, on, S.iconSw)}<div class="tlbl" style="color:${on ? th.brand : th.dim}">${label}</div></div>`;
  }).join('');
  return `<div class="tabbar">${cells}</div>`;
}
function markets(th, S) {
  const rows = coins.map((c, i) => {
    const fav = i < 2 || i === 3, col = c[3] ? th.up : th.down, sign = c[2] >= 0 ? '+' : '';
    const badge = S.changeBadge
      ? `<span class="chgb" style="color:${col};background:${col}1f">${sign}${c[2].toFixed(2)}%</span>`
      : `<span class="chgt" style="color:${col}">${sign}${c[2].toFixed(2)}%</span>`;
    return `<div class="mrow">
      <div class="mleft">${ico('star', 16, fav ? th.brand : th.dim, fav, S.iconSw)}
        <div><div class="tk">${c[0]}<span class="perp">PERP</span></div>
        <div class="sub">Vol ${c[5]} · Fund ${c[4]}</div></div></div>
      <div class="mpx"><div class="big">${c[1]}</div>${badge}</div></div>`;
  }).join('');
  return `${statusbar()}
    <div class="pad">
      <div class="h1row"><h1>行情 <span class="h1en">Markets</span></h1><span class="live"><i></i>LIVE</span></div>
      <div class="seg">${['全部', '自选'].map((s, i) => `<div class="segc ${i === 0 ? 'on' : ''}">${s}</div>`).join('')}</div>
      <div class="search">${ico('search', 15, th.dim, 0, S.iconSw)}<span>搜索市场</span></div>
      <div class="mlist">${rows}</div>
    </div>`;
}
function detail(th, S) {
  const ob = (px, sz, side) => {
    const col = side === 'a' ? th.down : th.up, depth = side === 'a' ? [70, 42, 88] : [60, 78, 95];
    return px.map((p, i) => `<div class="obr">
      <div class="obbar" style="background:${col}22;width:${depth[i]}%;${side === 'a' ? 'right:0' : 'left:0'}"></div>
      <span class="obpx" style="color:${col}">${p}</span><span class="obsz">${sz[i]}</span></div>`).join('');
  };
  return `${statusbar()}
    <div class="pad">
      <div class="dhead"><span class="back">${ico('chevron', 16, th.dim, 0, S.iconSw)}<b>BTC<span class="perp">PERP</span></b></span>
        <span class="chgb" style="color:${th.up};background:${th.up}1f">▲ 2.14%</span></div>
      <div class="price"><span class="pbig">62,481.5</span><span class="psub" style="color:${th.up}">+1,311.5 · +2.14%</span></div>
      <div class="tfs">${['1H', '4H', '1D', '1W'].map((tf, i) => `<span class="tf ${i === 0 ? 'on' : ''}">${tf}</span>`).join('')}</div>
      <div class="chart">${chartSvg(th, 300, 120)}</div>
      <div class="stats">
        ${[['标记价', '62,481.5'], ['24h 量', '1.2B'], ['资金费', '0.011%'], ['最大杠杆', '50×']].map(([a, b]) => `<div class="stat"><div class="sl">${a}</div><div class="sv">${b}</div></div>`).join('')}
      </div>
      <div class="obhead"><span>盘口</span><span>价差 5.0 (0.008%)</span></div>
      <div class="ob">${ob(['62,490', '62,488', '62,486'], ['1.31', '0.39', '1.74'], 'a')}
        ${ob(['62,485', '62,483', '62,481'], ['1.20', '0.84', '2.05'], 'b')}</div>
      <button class="cta">交易 BTC-PERP</button>
    </div>`;
}

const DIRS = [
  {
    key: 'A', name: 'A · Hyperliquid Native', vibe: '薄荷青 / 深石板 · 干净专业，贴合 HL 生态',
    th: { bg: '#0B0F12', surf: '#141B20', surf2: '#11171B', line: '#212C32', text: '#E8EEF2', dim: '#8493A0', brand: '#39E0C4', up: '#2EBD85', down: '#F6465D', candleRound: 0.5 },
    S: { sans: '-apple-system,"SF Pro Display",Inter,system-ui,sans-serif', mono: '"SF Mono",ui-monospace,"JetBrains Mono",monospace', padX: 18, radius: 14, wmTrack: '1.5px', iconSw: 1.7, changeBadge: true, density: 'normal' },
  },
  {
    key: 'B', name: 'B · Pro Terminal', vibe: '石墨 + 电青 · 高密度，给专业交易者',
    th: { bg: '#0A0C0E', surf: '#101418', surf2: '#0D1115', line: '#1E262C', text: '#D7DEE4', dim: '#727C85', brand: '#19E0B4', up: '#0ECB81', down: '#FF4D5E', candleRound: 0 },
    S: { sans: 'Inter,system-ui,-apple-system,sans-serif', mono: '"JetBrains Mono","SF Mono",ui-monospace,monospace', padX: 14, radius: 8, wmTrack: '2px', iconSw: 1.5, changeBadge: false, density: 'dense' },
  },
  {
    key: 'C', name: 'C · Premium Minimal', vibe: '靛紫 / 冷黑 · 留白大、圆角柔和，偏高端消费级',
    th: { bg: '#0C0C12', surf: '#16161F', surf2: '#13131B', line: '#262633', text: '#ECEDF3', dim: '#8C8DA0', brand: '#8B7CFF', up: '#3DD68C', down: '#FF6471', candleRound: 1 },
    S: { sans: '-apple-system,"SF Pro Display",Inter,system-ui,sans-serif', mono: '"SF Mono",ui-monospace,monospace', padX: 20, radius: 20, wmTrack: '1px', iconSw: 1.8, changeBadge: true, density: 'loose' },
  },
];

// One static, var-driven stylesheet (avoids cross-phone class collisions).
const STYLE = `
.phone{width:344px;background:var(--bg);border-radius:var(--phoneRadius);overflow:hidden;border:1px solid var(--line);box-shadow:0 24px 60px rgba(0,0,0,.5);display:flex;flex-direction:column}
.screen{height:686px;overflow:hidden;position:relative;font-family:var(--sans);padding-top:14px}
.sb{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 var(--padX)}
.sb-time{font:600 12px var(--mono);color:var(--dim)}
.sb-wm{font:800 13px var(--sans);letter-spacing:var(--wmTrack);color:var(--text)}
.pill{font:700 9.5px var(--sans);letter-spacing:.8px;color:var(--brand);border:1px solid color-mix(in srgb,var(--brand) 40%,transparent);border-radius:6px;padding:3px 7px;background:color-mix(in srgb,var(--brand) 9%,transparent)}
.pad{padding:14px var(--padX) 0}
.h1row{display:flex;align-items:baseline;justify-content:space-between;margin:6px 0 12px}
h1{font:800 21px var(--sans);color:var(--text);margin:0;letter-spacing:.3px}
.h1en{color:var(--dim);font-weight:600;font-size:14px}
.live{font:700 10px var(--sans);letter-spacing:1px;color:var(--up);display:inline-flex;align-items:center;gap:5px}
.live i{width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 8px var(--up)}
.seg{display:flex;gap:8px;margin-bottom:12px}
.segc{font:600 13px var(--sans);color:var(--dim);padding:7px 16px;border-radius:var(--segRadius);background:var(--surf2)}
.segc.on{color:var(--segOnText);background:var(--brand);font-weight:700}
.search{display:flex;align-items:center;gap:8px;background:var(--surf);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px}
.search span{color:var(--dim);font:500 13px var(--sans)}
.mlist{display:flex;flex-direction:column;gap:var(--mlistGap)}
.mrow{display:flex;align-items:center;justify-content:space-between;padding:var(--rowPadY) var(--rowPadX);background:var(--rowBg);border:var(--rowBorderFull);border-bottom:var(--rowBorderBottom);border-radius:var(--rowRadius)}
.mleft{display:flex;align-items:center;gap:11px}
.tk{font:700 var(--big) var(--sans);color:var(--text);display:flex;align-items:center;gap:6px}
.perp{font:700 8px var(--sans);letter-spacing:.5px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:1px 4px}
.sub{font:500 11px var(--sans);color:var(--dim);margin-top:3px}
.mpx{text-align:right}
.big{font:600 var(--big) var(--mono);color:var(--text)}
.chgb{display:inline-block;font:700 11.5px var(--mono);border-radius:6px;padding:2px 7px;margin-top:4px}
.chgt{display:inline-block;font:600 12.5px var(--mono);margin-top:4px}
.dhead{display:flex;align-items:center;justify-content:space-between;margin:4px 0 10px}
.back{display:flex;align-items:center;gap:4px;color:var(--text);font:700 15px var(--sans)}
.back b{display:flex;align-items:center;gap:6px}
.price{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.pbig{font:700 30px var(--mono);color:var(--text);letter-spacing:-.5px}
.psub{font:600 12.5px var(--mono)}
.tfs{display:flex;gap:7px;margin-bottom:10px}
.tf{font:600 12px var(--mono);color:var(--dim);padding:5px 12px;border-radius:8px;background:var(--surf2)}
.tf.on{color:var(--bg);background:var(--brand);font-weight:700}
.chart{background:var(--surf2);border:1px solid var(--line);border-radius:var(--radius);padding:8px;margin-bottom:12px}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:14px}
.stat{background:var(--surf);border:1px solid var(--line);border-radius:var(--statRadius);padding:8px}
.sl{font:500 9.5px var(--sans);color:var(--dim);margin-bottom:3px}
.sv{font:600 12px var(--mono);color:var(--text)}
.obhead{display:flex;justify-content:space-between;font:600 10.5px var(--sans);color:var(--dim);margin-bottom:7px}
.ob{display:flex;flex-direction:column;gap:3px;margin-bottom:14px}
.obr{position:relative;display:flex;justify-content:space-between;padding:4px 8px;border-radius:5px;overflow:hidden}
.obbar{position:absolute;top:0;bottom:0}
.obpx,.obsz{position:relative;font:600 11.5px var(--mono)}
.obsz{color:var(--dim)}
.cta{width:100%;border:none;border-radius:var(--ctaRadius);padding:14px;font:700 15px var(--sans);color:var(--bg);background:var(--brand);cursor:pointer}
.tabbar{display:flex;border-top:1px solid var(--line);background:var(--surf2);padding:8px 0 10px}
.tcell{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
.tlbl{font:600 10px var(--sans)}
`;

function vars(th, S) {
  const loose = S.density === 'loose', dense = S.density === 'dense', cards = loose;
  const v = {
    '--bg': th.bg, '--surf': th.surf, '--surf2': th.surf2, '--line': th.line,
    '--text': th.text, '--dim': th.dim, '--brand': th.brand, '--up': th.up, '--down': th.down,
    '--sans': S.sans, '--mono': S.mono, '--padX': S.padX + 'px', '--radius': S.radius + 'px',
    '--wmTrack': S.wmTrack, '--phoneRadius': (loose ? 30 : 26) + 'px', '--segRadius': (loose ? 12 : 9) + 'px',
    '--segOnText': loose ? '#fff' : th.bg, '--big': (dense ? 14 : 15) + 'px',
    '--statRadius': (loose ? 14 : 10) + 'px', '--ctaRadius': (loose ? 16 : 11) + 'px',
    '--rowPadY': (dense ? 8 : loose ? 15 : 12) + 'px', '--rowPadX': cards ? '12px' : '0px',
    '--rowBg': cards ? th.surf : 'transparent', '--rowBorderFull': cards ? `1px solid ${th.line}` : 'none',
    '--rowBorderBottom': cards ? 'none' : `1px solid ${th.line}`, '--rowRadius': cards ? '14px' : '0px',
    '--mlistGap': cards ? '8px' : '0px',
  };
  return Object.entries(v).map(([k, val]) => `${k}:${val}`).join(';');
}

function phone(inner, label, th, S, active) {
  return `<div class="pcol"><div class="plabel">${label}</div>
    <div class="phone" style="${vars(th, S)}"><div class="screen">${inner}</div>${tabbar(th, S, active)}</div></div>`;
}
function dirBlock(d) {
  return `<div class="dir">
    <div class="dhd"><span class="dk">${d.name}</span><span class="dv">${d.vibe}</span>
      <span class="sw"><i style="background:${d.th.bg}"></i><i style="background:${d.th.surf}"></i><i style="background:${d.th.brand}"></i><i style="background:${d.th.up}"></i><i style="background:${d.th.down}"></i></span></div>
    <div class="prow">${phone(markets(d.th, d.S), 'MARKETS · 行情', d.th, d.S, 'markets')}${phone(detail(d.th, d.S), 'MARKET DETAIL · 详情', d.th, d.S, 'markets')}</div>
  </div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08090B}
.stage{width:1320px;padding:40px;background:radial-gradient(120% 100% at 50% 0,#101319 0,#08090B 60%);font-family:-apple-system,"SF Pro Display",Inter,system-ui,sans-serif}
.title{font:800 30px -apple-system,Inter,sans-serif;color:#EAF0F4;letter-spacing:.5px}
.subtitle{font:500 14px Inter,sans-serif;color:#76828C;margin:8px 0 30px}
.dir{margin-bottom:38px;padding:22px;background:#0D1014;border:1px solid #1B2228;border-radius:22px}
.dhd{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.dk{font:800 18px Inter,sans-serif;color:#EAF0F4}
.dv{font:500 13px Inter,sans-serif;color:#8A95A0}
.sw{display:inline-flex;gap:5px;margin-left:auto}
.sw i{width:22px;height:22px;border-radius:6px;display:block;border:1px solid rgba(255,255,255,.08)}
.prow{display:flex;gap:26px}
.pcol{display:flex;flex-direction:column;gap:10px}
.plabel{font:700 10.5px Inter,sans-serif;letter-spacing:1.5px;color:#5C6770;text-align:center}
${STYLE}
</style></head><body><div class="stage">
  <div class="title">HYPERSOLID — UI 重设计方案（3 选 1，供决策）</div>
  <div class="subtitle">同一信息架构与中文文案，仅视觉语言不同 · 每个方向展示 行情 + 详情 两屏 · 对标主流交易所</div>
  ${DIRS.map(dirBlock).join('')}
</div></body></html>`;

fs.writeFileSync(__dirname + '/redesign.html', html);
console.log('wrote redesign.html');
