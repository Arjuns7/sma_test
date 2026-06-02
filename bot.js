// ═══════════════════════════════════════════════════════════════
// SMABot — Hyperliquid Testnet Trading Bot
// ═══════════════════════════════════════════════════════════════
// Requirements: npm install ccxt dotenv
// Usage:        node bot.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const ccxt = require('ccxt');

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  symbol:       'BTC/USDC:USDC',   // Hyperliquid perp format
  timeframe:    '1h',               // candle interval
  fastPeriod:   9,                  // fast EMA period
  slowPeriod:   50,                 // slow EMA period
  leverage:     3,                  // position leverage
  riskPct:      0.02,              // risk 2% of balance per trade
  useRsi:       true,
  rsiPeriod:    14,
  rsiOB:        65,                // skip longs above this RSI
  rsiOS:        35,                // skip shorts below this RSI
  useAtrStop:   true,
  atrPeriod:    14,
  atrMult:      1.5,               // ATR stop-loss multiplier
  useTrailing:  true,
  trailMult:    3.0,               // trailing stop ATR multiplier
  longOnly:     false,             // set true for long-only mode
  pollMs:       300000,            // poll interval (5 min for 1h candles)
  testnet:      true,              // true = testnet, false = mainnet
  maxDailyLoss: -500,             // kill switch: max daily loss USD
};

// ─── EXCHANGE SETUP ──────────────────────────────────────────
const WALLET = process.env.HL_WALLET_ADDRESS;

const exchange = new ccxt.hyperliquid({
  apiKey:          WALLET,
  secret:          process.env.HL_PRIVATE_KEY,
  walletAddress:   WALLET,
  privateKey:      process.env.HL_PRIVATE_KEY,
  enableRateLimit: true,
});

if (CONFIG.testnet) {
  exchange.setSandboxMode(true);
}

// ─── INDICATOR FUNCTIONS ─────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = closes.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    out[i] = (closes[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (avgGain += d) : (avgLoss -= d);
  }
  avgGain /= period; avgLoss /= period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  }
  return out;
}

function calcATR(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period] = sum / period;
  for (let i = period; i < trs.length; i++) {
    out[i + 1] = (out[i] * (period - 1) + trs[i]) / period;
  }
  return out;
}

// ─── BOT STATE ───────────────────────────────────────────────
let position = null;
let dailyPnL = 0;
let lastResetDay = new Date().toDateString();
let tradeCount = 0;

// ─── MAIN LOOP ───────────────────────────────────────────────
async function runBot() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       SMABot — Hyperliquid Trading Bot               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`⚡ Starting up...`);
  console.log(`   Network:   ${CONFIG.testnet ? '🧪 TESTNET' : '🔴 MAINNET'}`);
  console.log(`   Symbol:    ${CONFIG.symbol}`);
  console.log(`   Timeframe: ${CONFIG.timeframe}`);
  console.log(`   Strategy:  EMA ${CONFIG.fastPeriod}/${CONFIG.slowPeriod}`);
  console.log(`   Leverage:  ${CONFIG.leverage}x`);
  console.log(`   Mode:      ${CONFIG.longOnly ? 'Long Only' : 'Long + Short'}`);
  console.log(`   Risk:      ${CONFIG.riskPct * 100}% per trade`);
  console.log('');

  // Load markets
  try {
    console.log('📡 Loading markets...');
    await exchange.loadMarkets();
    console.log(`✅ Markets loaded (${Object.keys(exchange.markets).length} pairs)`);
  } catch (e) {
    console.error(`❌ Failed to load markets: ${e.message}`);
    process.exit(1);
  }

  // Set leverage
  try {
    await exchange.setLeverage(CONFIG.leverage, CONFIG.symbol);
    console.log(`✅ Leverage set to ${CONFIG.leverage}x`);
  } catch (e) {
    console.log(`⚠️  Could not set leverage: ${e.message}`);
  }

  // Fetch initial price
  try {
    const ticker = await exchange.fetchTicker(CONFIG.symbol);
    console.log(`✅ BTC price: $${ticker.last.toLocaleString()}`);
  } catch (e) {
    console.log(`⚠️  Could not fetch price: ${e.message}`);
  }

  // Check balance
  try {
    const balance = await exchange.fetchBalance({ user: WALLET });
    const usdc = balance.total?.USDC || balance.free?.USDC || 0;
    console.log(`✅ Balance: $${parseFloat(usdc).toFixed(2)} USDC`);
  } catch (e) {
    console.log(`⚠️  Could not fetch balance: ${e.message}`);
  }

  // Check for existing position on startup
  try {
    const positions = await exchange.fetchPositions([CONFIG.symbol], { user: WALLET });
    const pos = positions.find(p =>
      p.symbol === CONFIG.symbol && Math.abs(p.contracts) > 0
    );
    if (pos) {
      position = {
        side: pos.side === 'long' ? 'LONG' : 'SHORT',
        entryPrice: pos.entryPrice,
        size: Math.abs(pos.contracts),
        peakPrice: pos.entryPrice,
        troughPrice: pos.entryPrice,
      };
      console.log(`📌 Existing position: ${position.side} ${position.size} @ $${position.entryPrice}`);
    } else {
      console.log('📌 No open positions');
    }
  } catch (e) {
    console.log(`⚠️  Could not check positions: ${e.message}`);
  }

  console.log('');
  console.log('🔄 Entering main loop...');
  console.log('');

  // Main loop
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error(`❌ Tick error: ${e.message}`);
    }
    await sleep(CONFIG.pollMs);
  }
}

async function tick() {
  // Reset daily PnL counter
  const today = new Date().toDateString();
  if (today !== lastResetDay) {
    console.log(`📅 New day — resetting daily PnL (was $${dailyPnL.toFixed(2)})`);
    dailyPnL = 0;
    lastResetDay = today;
  }

  // Kill switch
  if (dailyPnL <= CONFIG.maxDailyLoss) {
    console.log(`🛑 KILL SWITCH — daily loss $${dailyPnL.toFixed(2)} exceeds limit`);
    if (position) await closePosition('kill-switch');
    return;
  }

  // Fetch candles (OHLCV format: [timestamp, open, high, low, close, volume])
  const needed = Math.max(CONFIG.slowPeriod, CONFIG.rsiPeriod, CONFIG.atrPeriod) + 5;
  const candles = await exchange.fetchOHLCV(
    CONFIG.symbol, CONFIG.timeframe, undefined, needed
  );

  if (candles.length < needed) {
    console.log(`⏳ Waiting for data (${candles.length}/${needed} candles)`);
    return;
  }

  const closes = candles.map(c => c[4]);
  const fastEMA = calcEMA(closes, CONFIG.fastPeriod);
  const slowEMA = calcEMA(closes, CONFIG.slowPeriod);
  const rsiVals = CONFIG.useRsi ? calcRSI(closes, CONFIG.rsiPeriod) : null;
  const atrVals = (CONFIG.useAtrStop || CONFIG.useTrailing)
    ? calcATR(candles, CONFIG.atrPeriod) : null;

  const i = closes.length - 1;
  const prevI = i - 1;

  const pf = fastEMA[prevI], ps = slowEMA[prevI];
  const cf = fastEMA[i],     cs = slowEMA[i];
  if (!pf || !ps || !cf || !cs) return;

  const price = closes[i];
  const rsiNow = rsiVals ? rsiVals[i] : null;
  const atrNow = atrVals ? atrVals[i] : null;
  const golden = pf <= ps && cf > cs;  // bullish crossover
  const death  = pf >= ps && cf < cs;  // bearish crossover

  const ts = new Date().toLocaleTimeString();
  const posInfo = position ? ` | Pos: ${position.side}` : '';
  console.log(
    `[${ts}] $${price.toFixed(2)} | Fast: ${cf.toFixed(2)} | Slow: ${cs.toFixed(2)}` +
    `${rsiNow ? ` | RSI: ${rsiNow.toFixed(1)}` : ''}` +
    `${atrNow ? ` | ATR: ${atrNow.toFixed(2)}` : ''}` +
    posInfo +
    (golden ? ' 🟢 GOLDEN CROSS' : '') +
    (death ? ' 🔴 DEATH CROSS' : '')
  );

  // ── STOP-LOSS & TRAILING STOP CHECK ──
  if (position && atrNow) {
    if (CONFIG.useAtrStop) {
      const stopDist = CONFIG.atrMult * atrNow;
      if (position.side === 'LONG' && price < position.entryPrice - stopDist) {
        console.log('🔴 ATR Stop-Loss hit!');
        await closePosition('atr-stop');
        return;
      }
      if (position.side === 'SHORT' && price > position.entryPrice + stopDist) {
        console.log('🔴 ATR Stop-Loss hit!');
        await closePosition('atr-stop');
        return;
      }
    }
    if (CONFIG.useTrailing) {
      const tsDist = CONFIG.trailMult * atrNow;
      if (position.side === 'LONG') {
        if (price > position.peakPrice) position.peakPrice = price;
        if (price < position.peakPrice - tsDist) {
          console.log(`🟡 Trailing Stop hit! (peak: $${position.peakPrice.toFixed(2)})`);
          await closePosition('trail-stop');
          return;
        }
      }
      if (position.side === 'SHORT') {
        if (price < position.troughPrice) position.troughPrice = price;
        if (price > position.troughPrice + tsDist) {
          console.log(`🟡 Trailing Stop hit! (trough: $${position.troughPrice.toFixed(2)})`);
          await closePosition('trail-stop');
          return;
        }
      }
    }
  }

  // ── SIGNAL LOGIC ──
  if (golden) {
    if (position?.side === 'SHORT') {
      await closePosition('crossover');
    }
    const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow > CONFIG.rsiOB;
    if (!position && !rsiBlocked) {
      await openPosition('LONG', price);
    }
  }

  if (death) {
    if (position?.side === 'LONG') {
      await closePosition('crossover');
    }
    if (!CONFIG.longOnly) {
      const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow < CONFIG.rsiOS;
      if (!position && !rsiBlocked) {
        await openPosition('SHORT', price);
      }
    }
  }
}

// ─── ORDER EXECUTION ─────────────────────────────────────────
async function openPosition(side, price) {
  try {
    const balance = await exchange.fetchBalance({ user: WALLET });
    const free = parseFloat(balance.free?.USDC || balance.total?.USDC || 0);
    const riskAmount = free * CONFIG.riskPct;
    const size = (riskAmount * CONFIG.leverage) / price;

    console.log(`\n🟢 OPENING ${side}`);
    console.log(`   Size:    ${size.toFixed(6)} BTC @ $${price.toFixed(2)}`);
    console.log(`   Balance: $${free.toFixed(2)} | Risk: $${riskAmount.toFixed(2)}`);

    const orderSide = side === 'LONG' ? 'buy' : 'sell';

    const order = await exchange.createOrder(
      CONFIG.symbol,
      'market',
      orderSide,
      size,
      price  // Hyperliquid uses price for slippage protection
    );

    position = {
      side,
      entryPrice: price,
      size,
      peakPrice: price,
      troughPrice: price,
    };
    tradeCount++;
    console.log(`✅ Order filled: ${order.id}`);
    console.log(`   Trade #${tradeCount}\n`);
  } catch (e) {
    console.error(`❌ Failed to open ${side}: ${e.message}`);
  }
}

async function closePosition(reason) {
  if (!position) return;
  try {
    const orderSide = position.side === 'LONG' ? 'sell' : 'buy';
    const ticker = await exchange.fetchTicker(CONFIG.symbol);
    const price = ticker.last;

    console.log(`\n🔴 CLOSING ${position.side} — reason: ${reason}`);

    const order = await exchange.createOrder(
      CONFIG.symbol,
      'market',
      orderSide,
      position.size,
      price
    );

    const pnl = position.side === 'LONG'
      ? (price - position.entryPrice) * position.size
      : (position.entryPrice - price) * position.size;

    dailyPnL += pnl;
    console.log(`   PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Daily: $${dailyPnL.toFixed(2)}`);
    console.log(`✅ Position closed: ${order.id}\n`);

    position = null;
  } catch (e) {
    console.error(`❌ Failed to close position: ${e.message}`);
  }
}

// ─── UTILITIES ───────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n⏹ Shutting down gracefully...');
  if (position) {
    console.log('⚠️  You have an open position! Close it manually on the Hyperliquid UI.');
  }
  process.exit(0);
});

// ─── START ───────────────────────────────────────────────────
runBot().catch(err => {
  console.error('💀 Fatal error:', err);
  process.exit(1);
});
