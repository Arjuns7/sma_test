'use strict';

const BINANCE = 'https://api.binance.com/api/v3';
const $ = id => document.getElementById(id);

// ═══ State ════════════════════════════════════════════════════════════════════════════════════════
let chart = null, candleSeries = null, fastSeries = null, slowSeries = null;
let equityChart = null, equitySeries = null;
let isRunning = false;

// ═══ Tab Switch ═══════════════════════════════════════════════════════════════════════════════════
function switchTab(name) {
  ['backtest','bot'].forEach(t => {
    $(`tab-${t}`).classList.toggle('tab--active', t === name);
    $(`panel-${t}`).classList.toggle('panel--active', t === name);
  });
}

// ═══ Live Price ═══════════════════════════════════════════════════════════════════════════════════
async function fetchLivePrice() {
  try {
    const r = await fetch(`${BINANCE}/ticker/price?symbol=BTCUSDT`);
    const d = await r.json();
    const p = parseFloat(d.price);
    $('price-value').textContent = '$' + p.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  } catch(e) {}
}
fetchLivePrice();
setInterval(fetchLivePrice, 10000);

// ═══ Data Fetcher ═════════════════════════════════════════════════════════════════════════════════
async function fetchKlines(symbol, interval, lookbackDays) {
  const endTime = Date.now();
  const startTime = endTime - lookbackDays * 86400000;
  let all = [], cur = startTime, page = 0;
  while (cur < endTime) {
    setProgress(`Fetching candles... (batch ${++page})`);
    const url = `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${endTime}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance API error ${r.status}`);
    const data = await r.json();
    if (!data.length) break;
    all = all.concat(data);
    cur = data[data.length-1][0] + 1;
    if (data.length < 1000) break;
    await new Promise(res => setTimeout(res, 120));
  }
  return all.map(k => ({
    time: Math.floor(k[0]/1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

// ═══ SMA / EMA ════════════════════════════════════════════════════════════════════════════════════
function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = closes.slice(0, period-1).reduce((a,b)=>a+b,0);
  for (let i = period-1; i < closes.length; i++) {
    sum += closes[i];
    out[i] = sum / period;
    sum -= closes[i - period + 1];
  }
  return out;
}

function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = closes.slice(0, period).reduce((a,b)=>a+b,0);
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    out[i] = (closes[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (avgGain += d) : (avgLoss -= d);
  }
  avgGain /= period;
  avgLoss /= period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out[period] = 100 - 100 / (1 + rs0);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

// ═══ ATR ══════════════════════════════════════════════════════════════════════════════════════════
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // First ATR is simple average of first `period` true ranges
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period] = sum / period;
  // Smoothed ATR for subsequent values
  for (let i = period; i < trs.length; i++) {
    out[i + 1] = (out[i] * (period - 1) + trs[i]) / period;
  }
  return out;
}

// ═══ Backtest ════════════════════════════════════════════════════════════════════════════════════
function backtest(candles, fast, slow, capital, feePct, opts = {}) {
  const closes = candles.map(c=>c.close);
  const maFunc = opts.maType === 'EMA' ? ema : sma;
  const fastMA = maFunc(closes, fast);
  const slowMA = maFunc(closes, slow);
  const fee = feePct / 100;
  const leverage = opts.leverage || 1;
  const longOnly = opts.longOnly || false;

  // Optional filters
  const useRsi = opts.useRsi || false;
  const rsiVals = useRsi ? rsi(closes, opts.rsiPeriod || 14) : null;
  const rsiOB = opts.rsiOB || 65;   // overbought: skip LONG entry
  const rsiOS = opts.rsiOS || 35;   // oversold:   skip SHORT entry

  const useAtr = opts.useAtr || false;
  const useTs  = opts.useTs  || false;
  const atrVals = (useAtr || useTs) ? atr(candles, opts.atrPeriod || 14) : null;
  const atrMult = opts.atrMult || 1.5;
  const tsMult  = opts.tsMult  || 3.0;

  const useTrend = opts.useTrend || false;
  const trendMA = useTrend ? maFunc(closes, opts.trendPeriod || 200) : null;

  const useVol = opts.useVol || false;
  const volSMA = useVol ? sma(candles.map(c=>c.volume), opts.volPeriod || 20) : null;

  const trades = [], signals = [];
  const equity = [{time: candles[0].time, value: capital}];
  let pos = null, id = 0;

  const closeTrade = (i, exitPrice, reason = 'signal') => {
    const posCapital = pos.entryCapital * leverage;
    const entryFee = posCapital * fee;
    const exitFee = posCapital * fee;
    
    let rawPnl = pos.side === 'LONG'
      ? (exitPrice - pos.entryPrice) / pos.entryPrice * posCapital
      : (pos.entryPrice - exitPrice) / pos.entryPrice * posCapital;
      
    let pnl = rawPnl - (entryFee + exitFee);
    capital += pnl;
    const dur = Math.round((candles[i].time - candles[pos.entryIndex].time) / 60);
    trades.push({
      id: ++id, side: pos.side,
      entryTime: pos.entryTime, exitTime: candles[i].time,
      entryPrice: pos.entryPrice, exitPrice,
      pnl, pnlPct: pnl / pos.entryCapital * 100,
      capital, duration: fmtDur(dur), reason
    });
    equity.push({time: candles[i].time, value: capital});
    pos = null;
  };

  const startIdx = Math.max(slow, opts.rsiPeriod || 14, opts.atrPeriod || 14, opts.trendPeriod || 200, opts.volPeriod || 20);

  for (let i = startIdx; i < candles.length; i++) {
    const pf = fastMA[i-1], ps = slowMA[i-1], cf = fastMA[i], cs = slowMA[i];
    if (!pf||!ps||!cf||!cs) continue;

    // ATR Stop-Loss check (before entry logic)
    if (useAtr && pos && atrVals[i]) {
      const stopDist = atrMult * atrVals[i];
      if (pos.side === 'LONG'  && candles[i].low  < pos.entryPrice - stopDist) {
        const stopPrice = pos.entryPrice - stopDist;
        signals.push({time:candles[i].time, position:'aboveBar', color:'#f39c12', shape:'arrowDown', text:'SL'});
        closeTrade(i, stopPrice, 'atr-stop');
        continue;
      }
      if (pos.side === 'SHORT' && candles[i].high > pos.entryPrice + stopDist) {
        const stopPrice = pos.entryPrice + stopDist;
        signals.push({time:candles[i].time, position:'belowBar', color:'#f39c12', shape:'arrowUp', text:'SL'});
        closeTrade(i, stopPrice, 'atr-stop');
        continue;
      }
    }

    // Trailing Stop check
    if (useTs && pos && atrVals[i]) {
      const tsDist = tsMult * atrVals[i];
      if (pos.side === 'LONG') {
        const trailStop = (pos.peakPrice || pos.entryPrice) - tsDist;
        if (candles[i].high > (pos.peakPrice || pos.entryPrice)) pos.peakPrice = candles[i].high;
        if (candles[i].low < trailStop) {
          signals.push({time:candles[i].time, position:'aboveBar', color:'#32ff7e', shape:'arrowDown', text:'TS'});
          closeTrade(i, trailStop, 'trail-stop');
          continue;
        }
      }
      if (pos.side === 'SHORT') {
        const trailStop = (pos.troughPrice || pos.entryPrice) + tsDist;
        if (candles[i].low < (pos.troughPrice || pos.entryPrice)) pos.troughPrice = candles[i].low;
        if (candles[i].high > trailStop) {
          signals.push({time:candles[i].time, position:'belowBar', color:'#32ff7e', shape:'arrowUp', text:'TS'});
          closeTrade(i, trailStop, 'trail-stop');
          continue;
        }
      }
    }

    const golden = pf <= ps && cf > cs;
    const death  = pf >= ps && cf < cs;
    const rsiNow = rsiVals ? rsiVals[i] : null;

    const trendOkForLong = !useTrend || (trendMA && trendMA[i] && candles[i].close > trendMA[i]);
    const trendOkForShort = !useTrend || (trendMA && trendMA[i] && candles[i].close < trendMA[i]);

    const volOk = !useVol || (volSMA && volSMA[i] && candles[i].volume > volSMA[i]);

    if (golden) {
      if (pos?.side === 'SHORT') { closeTrade(i, candles[i].close); signals.push({time:candles[i].time,position:'aboveBar',color:'#ff4757',shape:'arrowDown',text:'Short'}); }
      const rsiBlocked = useRsi && rsiNow !== null && rsiNow > rsiOB;
      if (!pos && !rsiBlocked && trendOkForLong && volOk) {
        pos = {side:'LONG', entryPrice:candles[i].close, entryTime:candles[i].time, entryIndex:i, entryCapital:capital};
        signals.push({time:candles[i].time,position:'belowBar',color:'#00d4aa',shape:'arrowUp',text:'Long'});
      }
    }
    if (death) {
      if (pos?.side === 'LONG') { closeTrade(i, candles[i].close); signals.push({time:candles[i].time,position:'belowBar',color:'#00d4aa',shape:'arrowUp',text:'Long'}); }
      if (!longOnly) {
        const rsiBlocked = useRsi && rsiNow !== null && rsiNow < rsiOS;
        if (!pos && !rsiBlocked && trendOkForShort && volOk) {
          pos = {side:'SHORT', entryPrice:candles[i].close, entryTime:candles[i].time, entryIndex:i, entryCapital:capital};
          signals.push({time:candles[i].time,position:'aboveBar',color:'#ff4757',shape:'arrowDown',text:'Short'});
        }
      }
    }
  }
  if (pos) closeTrade(candles.length-1, candles[candles.length-1].close);

  return { trades, signals, equity, fastMA, slowMA, finalCapital: capital,
    metrics: calcMetrics(trades, equity, capital, feePct) };
}

function calcMetrics(trades, equity, finalCapital, feePct) {
  const n = trades.length;
  const wins = trades.filter(t=>t.pnl>0).length;
  const totalReturn = (finalCapital - equity[0].value) / equity[0].value * 100;
  let peak = equity[0].value, maxDD = 0;
  for (const e of equity) { if(e.value>peak) peak=e.value; const dd=(peak-e.value)/peak*100; if(dd>maxDD) maxDD=dd; }
  const rets = trades.map(t=>t.pnlPct);
  const avg = rets.length ? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
  const std = rets.length>1 ? Math.sqrt(rets.reduce((a,b)=>a+(b-avg)**2,0)/rets.length) : 0;
  const barsPerYear = 365*24*4;
  const sharpe = std>0 ? (avg/std)*Math.sqrt(barsPerYear) : 0;
  const gp = trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const gl = Math.abs(trades.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0));
  return { n, wins, losses:n-wins, winRate:n?wins/n*100:0, totalReturn, maxDD, sharpe,
    pf: gl>0?gp/gl:gp>0?Infinity:0, gp, gl, netPnl: finalCapital - equity[0].value };
}

function fmtDur(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes/60), m = minutes%60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h/24), hr = h%24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

function initChart() {
  const el = $('chart-container');
  if (chart) { chart.remove(); chart = null; }
  $('chart-placeholder').style.display = 'none';
  chart = LightweightCharts.createChart(el, {
    layout:     { background:{type:'Solid',color:'#111318'}, textColor:'#8b91aa' },
    grid:       { vertLines:{color:'#1e2130'}, horzLines:{color:'#1e2130'} },
    crosshair:  { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor:'#272b3a' },
    timeScale:  { borderColor:'#272b3a', timeVisible:true, secondsVisible:false },
    width: el.clientWidth, height: el.clientHeight,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor:'#00d4aa', downColor:'#ff4757',
    borderUpColor:'#00d4aa', borderDownColor:'#ff4757',
    wickUpColor:'#00d4aa', wickDownColor:'#ff4757',
  });
  fastSeries = chart.addLineSeries({ color:'#00d4aa', lineWidth:1.5, priceLineVisible:false, lastValueVisible:false });
  slowSeries = chart.addLineSeries({ color:'#f7931a', lineWidth:1.5, priceLineVisible:false, lastValueVisible:false });
  new ResizeObserver(() => { if (chart) chart.resize(el.clientWidth, el.clientHeight); }).observe(el);
}

function initEquityChart(initialCapital) {
  const el = $('equity-container');
  if (equityChart) { equityChart.remove(); equityChart = null; }
  equityChart = LightweightCharts.createChart(el, {
    layout:    { background:{type:'Solid',color:'#111318'}, textColor:'#8b91aa' },
    grid:      { vertLines:{color:'#1e2130'}, horzLines:{color:'#1e2130'} },
    rightPriceScale: { borderColor:'#272b3a' },
    timeScale: { borderColor:'#272b3a', timeVisible:true, secondsVisible:false },
    width: el.clientWidth, height: el.clientHeight,
  });
  equitySeries = equityChart.addBaselineSeries({
    baseValue: { type:'price', price: initialCapital },
    topLineColor:'#00d4aa', topFillColor1:'rgba(0,212,170,0.25)', topFillColor2:'rgba(0,212,170,0.02)',
    bottomLineColor:'#ff4757', bottomFillColor1:'rgba(255,71,87,0.02)', bottomFillColor2:'rgba(255,71,87,0.25)',
    lineWidth:2,
  });
  new ResizeObserver(() => { if(equityChart) equityChart.resize(el.clientWidth, el.clientHeight); }).observe(el);
}

const fmt2 = n => n.toFixed(2);
const fmtPct = (n, sign=true) => (sign&&n>0?'+':'')+fmt2(n)+'%';
const fmtUSD = n => '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtTs  = ts => new Date(ts*1000).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});

function setProgress(msg) { $('progress-text').textContent = msg; }
function showError(msg)   { $('error-text').textContent = msg; $('error-box').classList.remove('hidden'); }
function hideError()      { $('error-box').classList.add('hidden'); }

function showMetrics(m, initialCapital, lookback) {
  const section = $('metrics-section');
  section.classList.remove('hidden');
  const wr = m.winRate;
  $('m-winrate').textContent = fmt2(wr) + '%';
  $('m-winrate').className = 'metric-value ' + (wr>=50?'positive':'negative');
  $('m-wins').textContent = `${m.wins} W / ${m.losses} L`;
  const tr = m.totalReturn;
  $('m-return').textContent = fmtPct(tr);
  $('m-return').className = 'metric-value ' + (tr>=0?'positive':'negative');
  $('m-pnl').textContent = (m.netPnl>=0?'+':'')+fmtUSD(m.netPnl)+' net';
  $('m-drawdown').textContent = '-'+fmt2(m.maxDD)+'%';
  $('m-drawdown').className = 'metric-value ' + (m.maxDD<15?'positive':'negative');
  $('m-trades').textContent = m.n;
  $('m-period').textContent = lookback + 'd lookback';
  const sh = m.sharpe;
  $('m-sharpe').textContent = fmt2(sh);
  $('m-sharpe').className = 'metric-value ' + (sh>=1?'positive':sh>=0?'':'negative');
  const pf = isFinite(m.pf) ? fmt2(m.pf) : '∞';
  $('m-pf').textContent = pf;
  $('m-pf').className = 'metric-value ' + (m.pf>=1?'positive':'negative');
}

function showQuickSummary(m, finalCapital) {
  $('quick-summary').classList.remove('hidden');
  $('qs-trades').textContent = m.n;
  $('qs-winrate').textContent = fmt2(m.winRate)+'%';
  $('qs-return').textContent = fmtPct(m.totalReturn);
  $('qs-capital').textContent = fmtUSD(finalCapital);
}

function renderTradeLog(trades) {
  const tbody = $('trade-tbody');
  tbody.innerHTML = '';
  $('trade-count-badge').textContent = trades.length + ' trades';
  $('trade-log-section').classList.remove('hidden');
  trades.slice().reverse().forEach(t => {
    const pos = t.pnl >= 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t.id}</td><td>${t.side}</td><td>${fmtTs(t.entryTime)}</td><td>${fmtUSD(t.entryPrice)}</td><td>${fmtTs(t.exitTime)}</td><td>${fmtUSD(t.exitPrice)}</td><td>${t.duration}</td><td class="${pos?'pnl-positive':'pnl-negative'}">${fmtUSD(t.pnl)}</td><td class="${pos?'pnl-positive':'pnl-negative'}">${fmtPct(t.pnlPct)}</td>`;
    tbody.appendChild(tr);
  });
}

function toggleChart(name) {
  const el = name === 'price' ? $('chart-container') : $('equity-container');
  const h = el.clientHeight === 380 ? 580 : 380;
  el.style.height = h + 'px';
  if (name === 'price' && chart) chart.resize(el.clientWidth, h);
  if (name === 'equity' && equityChart) equityChart.resize(el.clientWidth, h);
}

function setDirection(val) {
  $('direction').value = val;
  $('dir-both').classList.toggle('dir-btn--active', val === 'both');
  $('dir-long').classList.toggle('dir-btn--active', val === 'long');
}

function toggleFilter(name) {
  const enabled = $(name + '-enabled').checked;
  const opts = $(name + '-options');
  opts.classList.toggle('filter-options--disabled', !enabled);
}

async function handleRun() {
  if (isRunning) return;
  isRunning = true;
  hideError();
  $('progress-box').classList.remove('hidden');

  const sym = $('sym-select').value;
  const tf = $('tf-select').value;
  const maType = $('ma-type').value;
  const fast = parseInt($('fast-period').value);
  const slow = parseInt($('slow-period').value);
  const capital = parseFloat($('capital').value);
  const leverage = parseFloat($('leverage').value);
  const lookback = parseInt($('lookback').value);
  const feePct = parseFloat($('fee-pct').value);
  const longOnly = $('direction').value === 'long';

  // Read filter toggles
  const useRsi = $('rsi-enabled').checked;
  const useAtr = $('atr-enabled').checked;
  const useTrend = $('trend-enabled').checked;
  const useVol = $('vol-enabled').checked;
  const useTs = $('ts-enabled').checked;

  // Read filter parameters
  const rsiPeriod = parseInt($('rsi-period').value) || 14;
  const rsiOB = parseInt($('rsi-ob').value) || 65;
  const rsiOS = parseInt($('rsi-os').value) || 35;
  const atrPeriod = parseInt($('atr-period').value) || 14;
  const atrMult = parseFloat($('atr-mult').value) || 1.5;
  const trendPeriod = parseInt($('trend-period').value) || 200;
  const volPeriod = parseInt($('vol-period').value) || 20;
  const tsMult = parseFloat($('ts-mult').value) || 3.0;

  // Update header badge
  const symLabel = sym.replace('USDT', '/USDT');
  const dirLabel = longOnly ? 'Long Only' : 'Long + Short';
  $('header-badge').textContent = `${symLabel} · ${tf} · ${dirLabel}`;

  try {
    setProgress('Connecting to Binance...');
    const candles = await fetchKlines(sym, tf, lookback);
    setProgress('Running backtest...');
    const res = backtest(candles, fast, slow, capital, feePct, {
      maType, leverage, longOnly,
      useRsi, rsiPeriod, rsiOB, rsiOS,
      useAtr, atrPeriod, atrMult,
      useTrend, trendPeriod,
      useVol, volPeriod,
      useTs, tsMult
    });
    setProgress('Rendering chart...');
    initChart();
    candleSeries.setData(candles);
    const times = candles.map(c=>c.time);
    fastSeries.setData(res.fastMA.map((v,i)=>v?{time:times[i],value:v}:null).filter(Boolean));
    slowSeries.setData(res.slowMA.map((v,i)=>v?{time:times[i],value:v}:null).filter(Boolean));
    if (res.signals.length) candleSeries.setMarkers(res.signals);
    initEquityChart(capital);
    equitySeries.setData(res.equity);
    $('equity-card').classList.remove('hidden');
    $('equity-label').textContent = fmtUSD(res.finalCapital);
    showMetrics(res.metrics, capital, lookback);
    renderTradeLog(res.trades);
    showQuickSummary(res.metrics, res.finalCapital);
    $('progress-box').classList.add('hidden');
  } catch(e) { showError(e.message); $('progress-box').classList.add('hidden'); }
  finally { isRunning = false; }
}

const BOT_CODE = `// Hyperliquid Bot Skeleton`;
$('bot-code-block').textContent = BOT_CODE;
