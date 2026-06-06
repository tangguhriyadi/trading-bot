// scan_market — fetch Bybit USDT perpetuals, compute indicators, score & rank.
// Reuses credentials/client from bybit-mcp (../../bybit-mcp/src/client.js).
// Usage:
//   node scan.js                       # default watchlist
//   node scan.js BTCUSDT ETHUSDT ...   # custom symbols
//   node scan.js --tf 60 --bars 200    # interval (min) + kline count
//
// Writes a full markdown report to output/scan_market/scan-<ts>.md and
// prints compact JSON (top picks + counts + file path) to stdout.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient, call, getConfig } from '../../bybit-mcp/src/client.js';

const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'LTCUSDT', 'APTUSDT',
  'ARBUSDT', 'OPUSDT', 'NEARUSDT', 'INJUSDT', 'TIAUSDT', 'TONUSDT',
];

// ---- arg parsing -----------------------------------------------------------
const args = process.argv.slice(2);
let interval = '60';
let bars = 200;
const symbols = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tf') interval = args[++i];
  else if (args[i] === '--bars') bars = Number(args[++i]);
  else symbols.push(args[i].toUpperCase());
}
const universe = symbols.length ? symbols : DEFAULT_SYMBOLS;

// ---- indicator math --------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function macd(closes) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(line, 9);
  const hist = line.map((v, i) => v - signal[i]);
  return { hist: hist.at(-1), histPrev: hist.at(-2) };
}

function atr(highs, lows, closes, period = 14) {
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  if (tr.length < period) return null;
  const recent = tr.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

const pct = (n) => (n * 100);
const round = (n, d = 2) => (n == null ? null : Number(n.toFixed(d)));

// ---- per-symbol analysis ---------------------------------------------------
async function analyze(symbol) {
  const t = await call(getClient().getTickers({ category: 'linear', symbol }));
  if (!t.success || !t.result?.list?.length) return { symbol, error: t.error || 'no ticker' };
  const tk = t.result.list[0];

  const k = await call(getClient().getKline({ category: 'linear', symbol, interval, limit: bars }));
  if (!k.success || !k.result?.list?.length) return { symbol, error: k.error || 'no kline' };
  // Bybit returns newest-first: [start, open, high, low, close, volume, turnover]
  const rows = k.result.list.slice().reverse();
  const closes = rows.map((r) => Number(r[4]));
  const highs = rows.map((r) => Number(r[2]));
  const lows = rows.map((r) => Number(r[3]));
  const vols = rows.map((r) => Number(r[5]));

  const price = Number(tk.lastPrice);
  const chg24 = pct(Number(tk.price24hPcnt));      // %
  const funding = pct(Number(tk.fundingRate));     // % per interval (8h)
  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(highs, lows, closes);

  // recent swing S/R over last 50 bars (excluding the live bar)
  const lookback = closes.slice(-50, -1);
  const swingHigh = Math.max(...highs.slice(-50, -1));
  const swingLow = Math.min(...lows.slice(-50, -1));
  const nearRes = (swingHigh - price) / price; // fraction above price
  const nearSup = (price - swingLow) / price;  // fraction above support

  // volume spike: last closed bar vs avg of prior 20
  const lastVol = vols.at(-2);
  const avgVol = vols.slice(-22, -2).reduce((s, v) => s + v, 0) / 20;
  const volSpike = avgVol ? lastVol / avgVol : 1;

  // ---- scoring (positive=long bias, negative=short bias) ----
  let score = 0;
  const signals = [];

  if (chg24 >= 5) { score += 2; signals.push(`strong 24h momentum +${chg24.toFixed(1)}%`); }
  else if (chg24 <= -5) { score -= 2; signals.push(`strong 24h drop ${chg24.toFixed(1)}%`); }
  else if (chg24 >= 2) { score += 1; }
  else if (chg24 <= -2) { score -= 1; }

  if (r != null) {
    if (r < 30) { score += 1.5; signals.push(`RSI oversold (${r.toFixed(0)})`); }
    else if (r > 70) { score -= 1.5; signals.push(`RSI overbought (${r.toFixed(0)})`); }
    else if (r > 55) score += 0.5;
    else if (r < 45) score -= 0.5;
  }

  if (price > e20 && e20 > e50) { score += 2; signals.push('EMA uptrend (px>20>50)'); }
  else if (price < e20 && e20 < e50) { score -= 2; signals.push('EMA downtrend (px<20<50)'); }

  if (m.hist > 0 && m.hist > m.histPrev) { score += 1; signals.push('MACD rising'); }
  else if (m.hist < 0 && m.hist < m.histPrev) { score -= 1; signals.push('MACD falling'); }

  if (funding >= 0.05) { score -= 1; signals.push(`high funding +${funding.toFixed(3)}% (crowded longs)`); }
  else if (funding <= -0.05) { score += 1; signals.push(`neg funding ${funding.toFixed(3)}% (crowded shorts)`); }

  if (price > swingHigh) { score += 1.5; signals.push('breakout above 50-bar high'); }
  else if (price < swingLow) { score -= 1.5; signals.push('breakdown below 50-bar low'); }
  else if (nearRes <= 0.015 && nearRes >= 0) signals.push(`near resistance (${(nearRes * 100).toFixed(1)}% away)`);
  else if (nearSup <= 0.015 && nearSup >= 0) signals.push(`near support (${(nearSup * 100).toFixed(1)}% away)`);

  if (volSpike >= 2) signals.push(`volume spike ${volSpike.toFixed(1)}x`);

  const bias = score >= 2 ? 'LONG' : score <= -2 ? 'SHORT' : 'NEUTRAL';

  return {
    symbol,
    bias,
    score: round(score, 1),
    conviction: round(Math.abs(score), 1),
    price,
    chg24: round(chg24, 2),
    rsi: round(r, 0),
    funding: round(funding, 4),
    volSpike: round(volSpike, 1),
    atrPct: a ? round((a / price) * 100, 2) : null,
    support: round(swingLow, price < 1 ? 5 : 2),
    resistance: round(swingHigh, price < 1 ? 5 : 2),
    signals,
  };
}

// ---- run -------------------------------------------------------------------
const cfg = getConfig();
const results = [];
for (const s of universe) {
  try { results.push(await analyze(s)); }
  catch (e) { results.push({ symbol: s, error: e?.message || String(e) }); }
}

const ok = results.filter((r) => !r.error).sort((a, b) => b.conviction - a.conviction);
const errors = results.filter((r) => r.error);

// ---- markdown report -------------------------------------------------------
const now = new Date();
const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
const outDir = join(import.meta.dirname, '..', '..', 'output', 'scan_market');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `scan-${ts}.md`);

let md = `# Bybit Market Scan — ${now.toISOString()}\n\n`;
md += `Network: **${cfg.testnet ? 'testnet' : 'mainnet'}** · Category: linear (USDT perp) · TF: ${interval}m · Symbols: ${universe.length}\n\n`;
md += `| Symbol | Bias | Score | Price | 24h% | RSI | Funding% | ATR% | Signals |\n`;
md += `|---|---|--:|--:|--:|--:|--:|--:|---|\n`;
for (const r of ok) {
  md += `| ${r.symbol} | ${r.bias} | ${r.score} | ${r.price} | ${r.chg24} | ${r.rsi ?? '-'} | ${r.funding} | ${r.atrPct ?? '-'} | ${r.signals.join('; ')} |\n`;
}
if (errors.length) {
  md += `\n## Errors\n`;
  for (const e of errors) md += `- ${e.symbol}: ${e.error}\n`;
}
md += `\n_Not financial advice. Indicators computed from public Bybit data._\n`;
writeFileSync(outFile, md);

// ---- compact stdout for the agent -----------------------------------------
const top = ok.filter((r) => r.bias !== 'NEUTRAL').slice(0, 5);
console.log(JSON.stringify({
  generated: now.toISOString(),
  network: cfg.testnet ? 'testnet' : 'mainnet',
  timeframe: `${interval}m`,
  scanned: universe.length,
  file: outFile,
  longs: ok.filter((r) => r.bias === 'LONG').length,
  shorts: ok.filter((r) => r.bias === 'SHORT').length,
  errors: errors.length,
  top,
}, null, 2));
