// HyperSolid — ALL screens × 3 house styles. Professional dense layouts (from the
// accepted marketdetail) re-skinned in the original phosphor/terminal style, across
// the 3 theme tints: Electrum (dark gold = app default), Oscilloscope (dark orange),
// Daylight (light). Screens: 行情/交易/持仓/策略/钱包/详情.
//   node render-core.js all-styled.html all-styled.png
const fs = require('fs');

function svg(inner, size, sw, fill) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill || 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="${sw || 1.7}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${inner}</svg>`;
}
const ICON = {
  markets: (a) => `<polyline points="2,14 6,14 8.5,8 11,17 13.5,6 16,14 22,14"/>${a ? '<circle cx="13.5" cy="6" r="1.7" fill="currentColor" stroke="none"/>' : ''}`,
  trade: () => `<path d="M8 20V5"/><path d="M4.5 8.5 8 5l3.5 3.5"/><path d="M16 4v15"/><path d="M12.5 15.5 16 19l3.5-3.5"/>`,
  positions: () => `<path d="M12 3 21 8 12 13 3 8Z"/><path d="M3 12.5 12 17.5 21 12.5"/>`,
  agent: (a) => `<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6" ${a ? 'fill="currentColor" stroke="none"' : ''}/><path d="M12 1.5V4.5"/><path d="M12 19.5V22.5"/><path d="M1.5 12H4.5"/><path d="M19.5 12H22.5"/>`,
  account: () => `<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>`,
  star: () => `<path d="M12 3.2 14.7 9l6.3.7-4.7 4.3 1.3 6.2L12 17.1 6.4 20.2l1.3-6.2L3 9.7 9.3 9Z"/>`,
  search: () => `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20 15.5 15.5"/>`,
  back: () => `<path d="M15 5l-7 7 7 7"/>`,
  caret: () => `<path d="M6 9l6 6 6-6"/>`,
  chevR: () => `<path d="M9 6l6 6-6 6"/>`,
  shield: () => `<path d="M12 3 19 6v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6Z"/><path d="M9 12l2 2 4-4"/>`,
  bolt: () => `<path d="M13 2 5 13h6l-1 9 8-12h-6z"/>`,
  globe: () => `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>`,
  plus: () => `<path d="M12 5v14M5 12h14"/>`,
  wallet: () => `<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12h3"/>`,
};
function ico(name, px, color, a, sw, fill) {
  return `<span style="color:${color};display:inline-flex">${svg(ICON[name](a), px, sw, fill)}</span>`;
}
function trace(t, amp, seed) {
  const h = 26; let d = `M0 ${h / 2}`; const n = 64;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * 348;
    const s = Math.sin(i * 0.55 + seed) * amp * 0.6 + Math.sin(i * 0.17 + seed * 2) * amp * 0.4 + Math.sin(i * 1.9 + seed) * amp * 0.15;
    d += ` L${x.toFixed(1)} ${(h / 2 - s).toFixed(1)}`;
  }
  return `<div class="trace"><svg viewBox="0 0 348 ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <defs><filter id="g${seed}"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
    <path d="${d}" fill="none" stroke="${t.brand}" stroke-width="3" opacity="${t.dark ? 0.24 : 0.16}" filter="url(#g${seed})"/>
    <path d="${d}" fill="none" stroke="${t.hi}" stroke-width="1.1" opacity="${t.dark ? 1 : 0.7}"/></svg></div>`;
}
function spark(t, up, seed) {
  let d = 'M0 18'; const n = 20;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * 70;
    const y = 18 - (Math.sin(i * 0.7 + seed) * 5 + Math.sin(i * 0.3 + seed) * 4 + (up ? i * 0.25 : -i * 0.25));
    d += ` L${x.toFixed(1)} ${Math.max(2, Math.min(34, y)).toFixed(1)}`;
  }
  return `<svg width="70" height="36" viewBox="0 0 70 36"><path d="${d}" fill="none" stroke="${up ? t.up : t.down}" stroke-width="1.6"/></svg>`;
}

// chart
const LO = 63919, HI = 64865, CUR = 64745;
function series() {
  const shape = [0.42, 0.55, 0.38, 0.30, 0.16, 0.10, 0.05, 0.12, 0.22, 0.18, 0.28, 0.24, 0.33, 0.30, 0.26, 0.34, 0.30, 0.24, 0.31, 0.27, 0.33, 0.38, 0.30, 0.36, 0.42, 0.46, 0.55, 0.62, 0.70, 0.78, 0.74, 0.83, 0.90, 0.86, 0.94, 1.0, 0.96, 0.91, 0.88, 0.873];
  const px = (s) => LO + s * (HI - LO); const out = [];
  for (let i = 0; i < shape.length; i++) { const o = px(i === 0 ? 0.42 : shape[i - 1]), c = px(shape[i]); out.push([o, c, Math.min(HI, Math.max(o, c) + 22), Math.max(LO, Math.min(o, c) - 22)]); }
  return out;
}
function chart(t, w, h) {
  const cs = series(); const max = HI + 18, min = LO - 18; const y = (v) => ((max - v) / (max - min)) * h; const cw = w / cs.length; let body = '';
  [64865, 64550, 64234, 63919].forEach((p) => { body += `<line x1="0" y1="${y(p).toFixed(1)}" x2="${w}" y2="${y(p).toFixed(1)}" stroke="${t.grid}" stroke-width="1"/>`; });
  cs.forEach(([o, c, hi, lo], i) => {
    const x = i * cw + cw / 2, up = c >= o, col = up ? t.up : t.down; const top = y(Math.max(o, c)), bot = y(Math.min(o, c));
    body += `<line x1="${x.toFixed(1)}" y1="${y(hi).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>`;
    body += `<rect x="${(x - cw * 0.32).toFixed(1)}" y="${top.toFixed(1)}" width="${(cw * 0.64).toFixed(1)}" height="${Math.max(1.5, bot - top).toFixed(1)}" fill="${col}"/>`;
  });
  const cy = y(CUR); body += `<line x1="0" y1="${cy.toFixed(1)}" x2="${w}" y2="${cy.toFixed(1)}" stroke="${t.brand}" stroke-width="1" stroke-dasharray="4 4" opacity="0.9"/>`;
  return { svg: `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${body}</svg>`, cy, cur: CUR, axis: [64865, 64550, 64234, 63919].map((p) => ({ p, y: y(p) })), h };
}

const NAV = [['markets', '行情'], ['trade', '交易'], ['positions', '持仓'], ['agent', '策略'], ['account', '钱包']];
function statusbar(t, mid) {
  return `${trace(t, 6, 0.4)}<div class="status"><span class="t">20:12</span><span class="wm">HYPERSOLID</span><span class="rd"><i></i>${mid || 'SIGNAL'}</span></div>`;
}
function tabbar(t, active) {
  return `<div class="tabbar">${NAV.map(([k, l]) => { const on = k === active; return `<div class="tcell">${ico(k, 21, on ? t.brand : t.dim, on, 1.7)}<div class="tlbl" style="color:${on ? t.brand : t.dim};font-weight:${on ? 800 : 600}">${l}</div></div>`; }).join('')}</div>`;
}

// ---------------- screens ----------------
const coins = [['BTC', '64,731.5', 1.09, 1, '1.77B'], ['ETH', '3,002.18', -0.86, 0, '842M'], ['SOL', '148.22', 5.41, 1, '510M'], ['HYPE', '28.74', 1.07, 1, '333M'], ['ARB', '1.1820', -2.30, 0, '119M'], ['DOGE', '0.16420', 0.92, 1, '97M']];
function markets(t) {
  const rows = coins.map((c, i) => {
    const col = c[3] ? t.up : t.down, s = c[2] >= 0 ? '+' : '', fav = i < 2 || i === 3;
    return `<div class="mrow"><div class="mleft">${ico('star', 16, fav ? t.star : t.sub, 0, 0, fav ? t.star : 'none')}
      <div><div class="tk">${c[0]}<span class="perp">PERP</span></div><div class="sub">Vol ${c[4]}</div></div></div>
      <div class="spk">${spark(t, c[3], i)}</div>
      <div class="mpx"><div class="big">${c[1]}</div><span class="chgb" style="color:${col};background:${col}1c">${s}${c[2].toFixed(2)}%</span></div></div>`;
  }).join('');
  return `${statusbar(t)}<div class="pad"><div class="h1">行情 <span class="en">Markets</span></div>
    <div class="seg">${['合约', '现货', '自选'].map((x, i) => `<span class="segc ${i === 0 ? 'on' : ''}">${x}</span>`).join('')}</div>
    <div class="colhd"><span>名称 / 成交量</span><span>趋势</span><span>最新价 / 涨跌</span></div>
    <div class="mlist">${rows}</div></div>`;
}
function trade(t) {
  return `${statusbar(t)}<div class="pad">
    <div class="pairbar"><span class="pair">BTC-USDC <span class="perp">PERP</span> ${ico('caret', 13, t.dim, 0, 2)}</span><span class="pairpx">64,731.5 <span style="color:${t.up}">+1.09%</span></span></div>
    <div class="bs"><button class="bbtn buy">买入 / 做多</button><button class="bbtn sell">卖出 / 做空</button></div>
    <div class="otype">${['限价', '市价', '条件'].map((x, i) => `<span class="ot ${i === 0 ? 'on' : ''}">${x}</span>`).join('')}<span class="lev">20× 逐仓 ${ico('caret', 12, t.dim, 0, 2)}</span></div>
    <div class="field"><span class="fl">价格 (USDC)</span><span class="fv">64,731.5</span></div>
    <div class="field"><span class="fl">数量 (BTC)</span><span class="fv ph">0.00</span></div>
    <div class="slider"><div class="track"><div class="fill" style="width:50%"></div><div class="knob" style="left:50%"></div></div>
      <div class="ticks">${['0', '25%', '50%', '75%', '100%'].map((x) => `<span>${x}</span>`).join('')}</div></div>
    <div class="sum"><div class="sr"><span>可用</span><span>1,284.20 USDC</span></div><div class="sr"><span>保证金</span><span>≈ 161.83 USDC</span></div><div class="sr"><span>预计强平价</span><span>61,402.0</span></div></div>
    <button class="cta buyc">买入 / 做多 BTC</button></div>`;
}
function positions(t) {
  const ps = [['BTC', 'long', '0.124', '20×', '61,240', '64,731', '+432.10', 1], ['ETH', 'short', '2.50', '10×', '3,110', '3,002', '+268.40', 1], ['SOL', 'long', '18.0', '5×', '151.20', '148.22', '-53.64', 0]];
  const rows = ps.map((p) => `<div class="pcard"><div class="ph2"><span class="pcoin">${p[0]}<span class="perp">PERP</span></span>
    <span class="ptag ${p[1]}">${p[1] === 'long' ? '多' : '空'} · ${p[3]}</span><span class="ppnl" style="color:${p[7] ? t.up : t.down}">${p[6]} USDC</span></div>
    <div class="pg"><div><div class="gl">数量</div><div class="gv">${p[2]}</div></div><div><div class="gl">开仓价</div><div class="gv">${p[4]}</div></div>
    <div><div class="gl">标记价</div><div class="gv">${p[5]}</div></div><div><div class="gl">回报率</div><div class="gv" style="color:${p[7] ? t.up : t.down}">${p[7] ? '+' : ''}${(parseFloat(p[6].replace(',', '')) / 160).toFixed(1)}%</div></div></div></div>`).join('');
  return `${statusbar(t)}<div class="pad">
    <div class="acct"><div class="al">账户权益 (USDC)</div><div class="av">12,840.55</div>
      <div class="acr"><div><div class="al2">可用</div><div class="av2">1,284.20</div></div><div><div class="al2">未实现盈亏</div><div class="av2" style="color:${t.up}">+646.86</div></div></div></div>
    <div class="seg">${['持仓 3', '挂单 2', '历史'].map((x, i) => `<span class="segc ${i === 0 ? 'on' : ''}">${x}</span>`).join('')}</div>
    <div class="plist">${rows}</div></div>`;
}
function agent(t) {
  const cards = [['网格策略', 'BTC-USDC · 运行中', '+5.82%', 'bolt'], ['定投 DCA', 'ETH · 每周一', '+1.24%', 'agent']];
  const rows = cards.map((c) => `<div class="scard"><div class="sicon">${ico(c[3], 20, t.brand, 1, 1.8)}</div>
    <div class="smid"><div class="sname">${c[0]}</div><div class="sdesc">${c[1]}</div></div><div class="sret" style="color:${t.up}">${c[2]}</div>${ico('chevR', 16, t.sub, 0, 2)}</div>`).join('');
  return `${statusbar(t)}<div class="pad">
    <div class="hero"><div class="herol">本月策略收益</div><div class="herov" style="color:${t.up}">+7.06%</div><div class="herosub">2 个运行中 · 风险敞口受控</div></div>
    <div class="seclbl">我的策略</div><div class="slist">${rows}</div>
    <button class="cta ghost">${ico('plus', 16, t.text, 0, 2)} 创建新策略</button></div>`;
}
function account(t) {
  const items = [['shield', '安全与生物识别', 'Face ID 已启用'], ['globe', '网络', 'Testnet'], ['bolt', '主题', t.label], ['wallet', '导出 / 备份', '']];
  const rows = items.map((it) => `<div class="arow"><span class="ai">${ico(it[0], 19, t.text, 0, 1.8)}</span><span class="aname">${it[1]}</span><span class="aval">${it[2]}</span>${ico('chevR', 15, t.sub, 0, 2)}</div>`).join('');
  return `${statusbar(t)}<div class="pad">
    <div class="wcard"><div class="wtop"><span class="wlbl">本地钱包</span><span class="wbadge">非托管</span></div><div class="waddr">0x7a3f…9C42</div>
      <div class="wbal"><span>余额</span><b>12,840.55 USDC</b></div></div>
    <div class="alist">${rows}</div><button class="cta ghost">${ico('wallet', 16, t.text, 0, 1.8)} 管理钱包</button></div>`;
}
function detail(t) {
  const c = chart(t, 348, 178);
  const axisLabels = c.axis.map(({ p, y }) => `<div class="axlbl" style="top:${y.toFixed(1)}px">${p.toLocaleString()}</div>`).join('');
  const curTop = Math.min(c.h - 16, Math.max(2, c.cy - 9));
  const stat = (l, v) => `<div class="strow"><span class="sl">${l}</span><span class="sv">${v}</span></div>`;
  const ob = (rows, side) => rows.map(([px, sum, d]) => `<div class="obr ${side}"><div class="obbar" style="width:${d}%;background:${(side === 'bid' ? t.up : t.down)}22"></div>${side === 'bid' ? `<span class="obsum">${sum}</span><span class="obpx" style="color:${t.up}">${px}</span>` : `<span class="obpx" style="color:${t.down}">${px}</span><span class="obsum">${sum}</span>`}</div>`).join('');
  const TF = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'], IND1 = ['MA', 'EMA', 'BOLL', 'SAR', 'AVL'], IND2 = ['VOL', 'MACD', 'KDJ', 'RSI', 'ROC'];
  const PERF = [['今日', '+0.85%', 1], ['7days', '-2.36%', 0], ['30days', '-15.62%', 0], ['90days', '-8.25%', 0], ['180days', '-9.06%', 0], ['年线', '-9.06%', 0]];
  return `${statusbar(t)}<div class="dhd"><span class="hl">${ico('back', 21, t.text, 2)}<b>BTC-USDC</b><span class="kpill">合约 ${ico('caret', 12, t.brand, 2)}</span></span><span>${ico('star', 21, t.star, 0, t.star)}</span></div>
  <div class="quote"><div class="qleft"><div class="qbig">64,731</div><div class="qsub"><span style="color:${t.up}">$64,731.5</span> <span style="color:${t.up}">+1.09%</span></div><div class="qmark">标记价格 <b>64,733</b></div></div>
    <div class="qright">${stat('24H 最高', '64,865')}${stat('24H 最低', '63,242')}${stat('24H 量(USDC)', '1.77B')}${stat('未平仓(USDC)', '1.95B')}${stat('资金费率', '0.0010% · 00:47')}</div></div>
  <div class="tfs">${TF.map((x) => `<span class="tf ${x === '15m' ? 'on' : ''}">${x}</span>`).join('')}</div>
  <div class="chartwrap"><div class="chart">${c.svg}</div><div class="axis">${axisLabels}</div><div class="curbadge" style="top:${curTop}px">${c.cur.toLocaleString()}</div>
    <div class="xax">${['06:00', '07:30', '09:00', '10:30', '12:00'].map((x) => `<span>${x}</span>`).join('')}</div></div>
  <div class="inds">${IND1.map((x, i) => `<span class="ind ${i === 0 ? 'on' : ''}">${x}</span>`).join('')}<span class="indsep"></span>${IND2.map((x) => `<span class="ind">${x}</span>`).join('')}</div>
  <div class="perf">${PERF.map(([l, v, up]) => `<div class="pf"><div class="pfl">${l}</div><div class="pfv" style="color:${up ? t.up : t.down}">${v}</div></div>`).join('')}</div>
  <div class="btabs"><span class="bt on">委托簿</span><span class="bt">最新成交</span></div>
  <div class="ls"><div class="lsbar"><div class="lsl" style="width:87.84%"></div><div class="lsr" style="width:12.16%"></div></div><div class="lslab"><span style="color:${t.up}">Long 87.84%</span><span style="color:${t.down}">12.16% Short</span></div></div>
  <div class="obhd"><span>买盘</span><span>卖盘</span><span class="grp">1 ${ico('caret', 11, t.dim, 2)}</span></div>
  <div class="obcols"><span>Sum</span><span>价格</span><span>价格</span><span>Sum</span></div>
  <div class="obbook"><div class="obside">${ob([['64,730', '0.812', 60], ['64,728', '0.402', 78], ['64,725', '1.205', 95]], 'bid')}</div><div class="obside">${ob([['64,733', '0.318', 55], ['64,736', '0.927', 72], ['64,740', '0.451', 88]], 'ask')}</div></div>
  <div class="cta-wrap"><button class="cta detailcta">交 易</button></div>`;
}

const SCREENS = [['markets', '行情', markets], ['trade', '交易', trade], ['positions', '持仓', positions], ['agent', '策略', agent], ['account', '钱包', account], ['detail', '详情', detail]];

function css(t) {
  const knobBorder = t.dark ? '#fff' : '#fff';
  return `
  .phone{width:340px;background:${t.bg};border-radius:28px;overflow:hidden;border:1px solid ${t.line2};box-shadow:0 22px 54px rgba(0,0,0,${t.dark ? 0.55 : 0.18})}
  .screen{font-family:ui-monospace,"SF Mono","JetBrains Mono",monospace;position:relative;height:818px;overflow:hidden}
  .pad{padding:8px 16px 0}
  .trace{height:24px;opacity:.95}
  .status{display:flex;justify-content:space-between;align-items:center;padding:2px 18px}
  .status .t{font:600 12px ui-monospace,monospace;color:${t.dim}}
  .wm{font:800 12px ui-monospace,monospace;color:${t.brand};letter-spacing:2.5px}
  .rd{display:inline-flex;align-items:center;gap:5px;font:700 8.5px ui-monospace,monospace;letter-spacing:1.2px;color:${t.up}}
  .rd i{width:5px;height:5px;border-radius:50%;background:${t.up};box-shadow:0 0 6px ${t.up}}
  .h1{font:800 22px ui-monospace,monospace;color:${t.text};margin:6px 0 12px}
  .en{color:${t.dim};font-weight:600;font-size:13px}
  .seg{display:flex;gap:7px;margin-bottom:12px}
  .segc{font:600 12px ui-monospace,monospace;color:${t.dim};background:${t.surf};border:1px solid ${t.line};border-radius:8px;padding:6px 13px}
  .segc.on{color:${t.ctaText};background:${t.brand};border-color:${t.brand};font-weight:800}
  .colhd{display:flex;justify-content:space-between;padding:0 2px 8px;border-bottom:1px solid ${t.line}}
  .colhd span{font:500 10px ui-monospace,monospace;color:${t.dim}}
  .colhd span:nth-child(2){flex:0 0 70px;text-align:center}.colhd span:nth-child(3){text-align:right}
  .mrow{display:flex;align-items:center;justify-content:space-between;padding:12px 2px;border-bottom:1px solid ${t.line}}
  .mleft{display:flex;align-items:center;gap:10px;flex:1}
  .tk{font:700 15px ui-monospace,monospace;color:${t.text};display:flex;align-items:center;gap:6px}
  .perp{font:700 7.5px ui-monospace,monospace;letter-spacing:.4px;color:${t.dim};border:1px solid ${t.line2};border-radius:4px;padding:1px 4px}
  .sub{font:500 10.5px ui-monospace,monospace;color:${t.dim};margin-top:3px}
  .spk{flex:0 0 70px;display:flex;justify-content:center}
  .mpx{text-align:right;flex:1}
  .big{font:600 14.5px ui-monospace,monospace;color:${t.text}}
  .chgb{display:inline-block;font:700 11px ui-monospace,monospace;border-radius:6px;padding:3px 7px;margin-top:5px}
  .pairbar{display:flex;justify-content:space-between;align-items:center;background:${t.surf};border:1px solid ${t.line};border-radius:11px;padding:11px 13px;margin-bottom:13px}
  .pair{font:800 15px ui-monospace,monospace;color:${t.text};display:flex;align-items:center;gap:6px}
  .pairpx{font:700 13px ui-monospace,monospace;color:${t.text}}
  .bs{display:flex;gap:9px;margin-bottom:13px}
  .bbtn{flex:1;border:none;border-radius:10px;padding:12px;font:800 13.5px ui-monospace,monospace;cursor:pointer}
  .bbtn.buy{background:${t.up}1f;color:${t.up}}.bbtn.sell{background:${t.surf};color:${t.dim};border:1px solid ${t.line}}
  .otype{display:flex;align-items:center;gap:14px;margin-bottom:13px}
  .ot{font:600 12.5px ui-monospace,monospace;color:${t.dim}}.ot.on{color:${t.brand};font-weight:800}
  .lev{margin-left:auto;font:600 11.5px ui-monospace,monospace;color:${t.text};background:${t.surf};border:1px solid ${t.line};border-radius:7px;padding:5px 9px;display:flex;align-items:center;gap:4px}
  .field{display:flex;justify-content:space-between;align-items:center;background:${t.surf};border:1px solid ${t.line};border-radius:11px;padding:13px;margin-bottom:9px}
  .fl{font:500 12px ui-monospace,monospace;color:${t.dim}}.fv{font:700 15px ui-monospace,monospace;color:${t.text}}.fv.ph{color:${t.sub}}
  .slider{margin:8px 2px 15px}
  .track{position:relative;height:5px;background:${t.line2};border-radius:3px}
  .fill{position:absolute;left:0;top:0;bottom:0;background:${t.brand};border-radius:3px}
  .knob{position:absolute;top:50%;width:15px;height:15px;border-radius:50%;background:${t.brand};transform:translate(-50%,-50%);border:3px solid ${knobBorder};box-shadow:0 1px 4px rgba(0,0,0,.25)}
  .ticks{display:flex;justify-content:space-between;margin-top:9px}.ticks span{font:600 10px ui-monospace,monospace;color:${t.dim}}
  .sum{background:${t.surf2};border:1px solid ${t.line};border-radius:11px;padding:11px 13px;margin-bottom:15px}
  .sr{display:flex;justify-content:space-between;padding:4px 0;font:500 12px ui-monospace,monospace;color:${t.dim}}
  .sr span:last-child{color:${t.text};font-weight:600}
  .acct{background:${t.brand};border-radius:15px;padding:15px;margin-bottom:13px;color:${t.ctaText}}
  .al{font:500 10.5px ui-monospace,monospace;opacity:.7;margin-bottom:4px}
  .av{font:800 25px ui-monospace,monospace;letter-spacing:-.5px}
  .acr{display:flex;gap:28px;margin-top:13px}
  .al2{font:500 9.5px ui-monospace,monospace;opacity:.7;margin-bottom:3px}.av2{font:700 13.5px ui-monospace,monospace}
  .pcard{background:${t.surf2};border:1px solid ${t.line};border-radius:13px;padding:12px;margin-bottom:9px}
  .ph2{display:flex;align-items:center;gap:9px;margin-bottom:10px}
  .pcoin{font:800 14.5px ui-monospace,monospace;color:${t.text};display:flex;align-items:center;gap:5px}
  .ptag{font:700 10.5px ui-monospace,monospace;border-radius:6px;padding:2px 7px}
  .ptag.long{color:${t.up};background:${t.up}1f}.ptag.short{color:${t.down};background:${t.down}1f}
  .ppnl{margin-left:auto;font:800 14px ui-monospace,monospace}
  .pg{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:7px}
  .gl{font:500 9.5px ui-monospace,monospace;color:${t.dim};margin-bottom:3px}.gv{font:700 12px ui-monospace,monospace;color:${t.text}}
  .hero{background:${t.brand};border-radius:15px;padding:17px;color:${t.ctaText};margin-bottom:16px}
  .herol{font:500 11.5px ui-monospace,monospace;opacity:.72}
  .herov{font:800 31px ui-monospace,monospace;margin:4px 0;letter-spacing:-1px}
  .herosub{font:500 11px ui-monospace,monospace;opacity:.72}
  .seclbl{font:700 12.5px ui-monospace,monospace;color:${t.text};margin-bottom:9px}
  .scard{display:flex;align-items:center;gap:11px;background:${t.surf2};border:1px solid ${t.line};border-radius:13px;padding:13px;margin-bottom:9px}
  .sicon{width:38px;height:38px;border-radius:10px;background:${t.surf};display:flex;align-items:center;justify-content:center}
  .smid{flex:1}.sname{font:700 14px ui-monospace,monospace;color:${t.text}}.sdesc{font:500 11px ui-monospace,monospace;color:${t.dim};margin-top:3px}
  .sret{font:800 14px ui-monospace,monospace;margin-right:6px}
  .wcard{background:${t.brand};border-radius:15px;padding:17px;color:${t.ctaText};margin-bottom:15px}
  .wtop{display:flex;justify-content:space-between;align-items:center;margin-bottom:13px}
  .wlbl{font:600 12.5px ui-monospace,monospace;opacity:.85}
  .wbadge{font:700 9.5px ui-monospace,monospace;background:${t.dark ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.22)'};border-radius:6px;padding:3px 8px}
  .waddr{font:700 17px ui-monospace,monospace;letter-spacing:.5px;margin-bottom:13px}
  .wbal{display:flex;justify-content:space-between;align-items:baseline;font:500 11.5px ui-monospace,monospace;opacity:.9}
  .wbal b{font:800 16px ui-monospace,monospace;opacity:1}
  .arow{display:flex;align-items:center;gap:12px;padding:14px 4px;border-bottom:1px solid ${t.line}}
  .ai{width:33px;height:33px;border-radius:9px;background:${t.surf};display:flex;align-items:center;justify-content:center}
  .aname{font:600 13.5px ui-monospace,monospace;color:${t.text};flex:1}.aval{font:500 12px ui-monospace,monospace;color:${t.dim}}
  .dhd{display:flex;align-items:center;justify-content:space-between;padding:8px 18px 6px}
  .hl{display:flex;align-items:center;gap:9px}.hl b{font:800 18px ui-monospace,monospace;color:${t.text};letter-spacing:.4px}
  .kpill{display:inline-flex;align-items:center;gap:3px;font:600 11px ui-monospace,monospace;color:${t.brand};background:${t.pill};border:1px solid ${t.brand}40;border-radius:6px;padding:3px 7px}
  .quote{display:flex;justify-content:space-between;padding:4px 18px 2px;gap:12px}
  .qbig{font:800 34px ui-monospace,monospace;letter-spacing:-1px;line-height:1.05;color:${t.text}}
  .qsub{font:700 13px ui-monospace,monospace;margin-top:3px}
  .qmark{font:500 11px ui-monospace,monospace;color:${t.dim};margin-top:5px}.qmark b{color:${t.text};font-weight:700}
  .qright{flex:1;max-width:188px;padding-top:2px}
  .strow{display:flex;justify-content:space-between;margin-bottom:4px}
  .sl{font:500 10px ui-monospace,monospace;color:${t.dim}}.sv{font:600 10.5px ui-monospace,monospace;color:${t.text}}
  .tfs{display:flex;justify-content:space-between;padding:10px 14px 6px}
  .tf{font:600 11.5px ui-monospace,monospace;color:${t.dim};padding:4px 5px}
  .tf.on{color:${t.ctaText};font-weight:800;background:${t.brand};border-radius:7px;padding:4px 9px}
  .chartwrap{position:relative;padding:2px 10px 0}.chart{height:178px}
  .axis{position:absolute;right:12px;top:0;height:178px;width:54px}
  .axlbl{position:absolute;right:0;font:600 10px ui-monospace,monospace;color:${t.sub};transform:translateY(-50%)}
  .curbadge{position:absolute;right:12px;font:700 10px ui-monospace,monospace;color:${t.ctaText};background:${t.brand};border-radius:4px;padding:2px 5px}
  .xax{display:flex;justify-content:space-between;padding:7px 4px 0}.xax span{font:600 10px ui-monospace,monospace;color:${t.sub}}
  .inds{display:flex;align-items:center;gap:11px;padding:12px 16px 9px;border-bottom:1px solid ${t.line};overflow:hidden}
  .ind{font:600 11.5px ui-monospace,monospace;color:${t.dim};white-space:nowrap}.ind.on{color:${t.brand};font-weight:800}
  .indsep{width:1px;height:12px;background:${t.line2}}
  .perf{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid ${t.line}}
  .pfl{font:500 9.5px ui-monospace,monospace;color:${t.dim};margin-bottom:4px}.pfv{font:700 11px ui-monospace,monospace}
  .btabs{display:flex;gap:20px;padding:12px 18px 0}
  .bt{font:700 13px ui-monospace,monospace;color:${t.dim};padding-bottom:7px}.bt.on{color:${t.text};border-bottom:2.5px solid ${t.brand}}
  .ls{padding:10px 16px 6px}.lsbar{display:flex;height:20px;border-radius:5px;overflow:hidden;gap:2px}
  .lsl{background:${t.up}30}.lsr{background:${t.down}30}
  .lslab{display:flex;justify-content:space-between;margin-top:5px;font:700 11px ui-monospace,monospace}
  .obhd{display:flex;align-items:center;padding:8px 16px 2px}.obhd span{flex:1;font:700 12px ui-monospace,monospace;color:${t.text}}
  .obhd .grp{flex:0 0 auto;display:inline-flex;align-items:center;gap:3px;font:600 11px ui-monospace,monospace;color:${t.dim}}
  .obcols{display:flex;padding:5px 16px 3px}.obcols span{flex:1;font:500 9px ui-monospace,monospace;color:${t.dim}}
  .obcols span:nth-child(2),.obcols span:nth-child(3){text-align:center}.obcols span:nth-child(4){text-align:right}
  .obbook{display:flex;gap:9px;padding:0 16px}.obside{flex:1;display:flex;flex-direction:column;gap:3px}
  .obr{position:relative;display:flex;justify-content:space-between;padding:4px 7px;border-radius:4px;overflow:hidden}
  .obr .obbar{position:absolute;top:0;bottom:0}.obr.bid .obbar{right:0}.obr.ask .obbar{left:0}
  .obpx,.obsum{position:relative;font:600 11px ui-monospace,monospace}.obsum{color:${t.dim}}
  .cta{position:absolute;left:16px;right:16px;bottom:86px;border:none;border-radius:12px;padding:15px;font:800 14.5px ui-monospace,monospace;color:${t.ctaText};background:${t.cta};cursor:pointer}
  .cta.buyc{background:${t.up};color:#fff}
  .cta.ghost{background:${t.surf};color:${t.text};border:1px solid ${t.line2};display:flex;align-items:center;justify-content:center;gap:7px}
  .cta.detailcta{letter-spacing:4px;box-shadow:0 0 20px ${t.brand}33}
  .cta-wrap{position:absolute;left:0;right:0;bottom:62px;padding:10px 0 0;background:linear-gradient(${t.bg}00,${t.bg} 40%)}
  .cta-wrap .cta{position:static;left:auto;right:auto;bottom:auto;margin:0 16px}
  .tabbar{position:absolute;left:0;right:0;bottom:0;display:flex;border-top:1px solid ${t.line};background:${t.surf2};padding:8px 0 11px}
  .tcell{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}.tlbl{font-size:9.5px;font-family:ui-monospace,monospace}
  `;
}
function scopedCss(t, id) {
  return css(t).replace(/(^|\})\s*([.#][^{},]+(?:,[^{}]+)*)\s*\{/g, (m, brace, sel) => `${brace} ${sel.split(',').map((s) => `#${id} ${s.trim()}`).join(',')}{`);
}

const THEMES = [
  { id: 'E', label: '浅色', name: 'Electrum · 琥珀金（App 默认）', dark: true, bg: '#0A1217', surf: '#0F1A20', surf2: '#0C151A', line: '#20303A', line2: '#27414C', text: '#EAF1F4', dim: '#7E929C', sub: '#566571', brand: '#E8C98F', hi: '#F6E4BE', up: '#34C98B', down: '#FF5C63', star: '#E8C98F', cta: '#E8C98F', ctaText: '#0A1217', grid: 'rgba(232,201,143,.06)', pill: 'rgba(232,201,143,.12)' },
  { id: 'O', label: '深色', name: 'Oscilloscope · 橙琥珀', dark: true, bg: '#0C0A07', surf: '#14110B', surf2: '#100D08', line: '#2A2418', line2: '#352D1C', text: '#F3ECDD', dim: '#9A8E73', sub: '#6E6450', brand: '#FFB454', hi: '#FFD9A0', up: '#6FE0C0', down: '#FF7A6B', star: '#FFB454', cta: '#FFB454', ctaText: '#1A1206', grid: 'rgba(255,180,84,.07)', pill: 'rgba(255,180,84,.12)' },
  { id: 'D', label: '亮色', name: 'Daylight · 浅色（清爽）', dark: false, bg: '#EEF1F3', surf: '#FFFFFF', surf2: '#F6F8FA', line: '#DFE4E9', line2: '#CBD5D8', text: '#11201F', dim: '#5A6B6E', sub: '#93A0A3', brand: '#0E5A6B', hi: '#0E5A6B', up: '#1E7F5C', down: '#C0492F', star: '#D9A441', cta: '#11201F', ctaText: '#FFFFFF', grid: 'rgba(14,32,31,.05)', pill: 'rgba(14,90,107,.10)' },
];

function themeSection(t) {
  const phones = SCREENS.map(([k, lab, fn]) => `<div class="col"><div class="clabel">${lab}</div><div class="phone"><div class="screen">${fn(t)}${tabbar(t, k === 'detail' ? 'markets' : k)}</div></div></div>`).join('');
  return `<div id="${t.id}" class="section"><div class="shd"><span class="sname2">${t.name}</span>
    <span class="sw"><i style="background:${t.bg};border:1px solid ${t.line2}"></i><i style="background:${t.brand}"></i><i style="background:${t.up}"></i><i style="background:${t.down}"></i></span></div>
    <style>${scopedCss(t, t.id)}</style><div class="row">${phones}</div></div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05060A}
.stage{width:2280px;padding:46px;background:radial-gradient(110% 50% at 50% 0,#0C1016 0,#05060A 55%);font-family:Inter,-apple-system,system-ui,sans-serif}
.title{font:800 30px Inter,sans-serif;color:#EAF0F4}
.subtitle{font:500 14px Inter,sans-serif;color:#76828C;margin:8px 0 32px}
.section{margin-bottom:42px;padding:24px;background:#0B0E12;border:1px solid #191F25;border-radius:24px}
.shd{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.sname2{font:800 19px Inter,sans-serif;color:#EAF0F4}
.sw{display:inline-flex;gap:5px}.sw i{width:22px;height:22px;border-radius:6px;display:block}
.row{display:flex;gap:24px}
.col{display:flex;flex-direction:column;gap:10px;align-items:center}
.clabel{font:800 11px Inter,sans-serif;color:#8A95A0;letter-spacing:2px}
</style></head><body><div class="stage">
  <div class="title">HYPERSOLID — 全部页面 × 三种风格</div>
  <div class="subtitle">同一专业布局（采纳的 marketdetail 元素密度）+ 原磷光/终端风 · 三种家族主题：Electrum 琥珀金 / Oscilloscope 橙琥珀 / Daylight 浅色 · 每行 6 屏：行情·交易·持仓·策略·钱包·详情</div>
  ${THEMES.map(themeSection).join('')}
</div></body></html>`;

fs.writeFileSync(__dirname + '/all-styled.html', html);
console.log('wrote all-styled.html');
