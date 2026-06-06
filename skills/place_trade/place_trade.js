// place_trade — risk-based Bybit perp order with SL/TP/leverage bracket.
// Reuses credentials/client from bybit-mcp (../../bybit-mcp/src/client.js).
//
// SAFE BY DEFAULT: without --confirm it only computes and prints the plan
// (dry-run). It places real orders ONLY when --confirm is passed.
//
// Usage:
//   node place_trade.js --symbol BTCUSDT --side Buy --entry 60000 \
//        [--sl 57000] [--tp 66000] [--risk 1] [--risk-usdt 50] \
//        [--lev 10] [--type Limit|Market] [--rr 2] [--tif GTC] [--confirm]
//
// Defaults: risk 1% equity, SL 5% from entry, TP = 2R, leverage 10x,
//           order type Limit, category linear, one-way (positionIdx 0).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient, call, getConfig, hasCredentials } from '../../bybit-mcp/src/client.js';

const DEFAULTS = { riskPct: 1, slPct: 5, rr: 2, leverage: 5, type: 'Limit', tif: 'GTC' };

// Shared risk policy (risk_rules.json at project root), enforced as a hard gate.
function readRules() {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'risk_rules.json'), 'utf8')); }
  catch { return {}; }
}

// ---- arg parsing -----------------------------------------------------------
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (k === '--confirm') opt.confirm = true;
  else if (k.startsWith('--')) opt[k.slice(2)] = a[++i];
}

function fail(msg, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2));
  process.exit(1);
}

const symbol = (opt.symbol || '').toUpperCase();
let side = opt.side || '';
side = /buy|long/i.test(side) ? 'Buy' : /sell|short/i.test(side) ? 'Sell' : '';
const entry = Number(opt.entry);
const type = opt.type || DEFAULTS.type;
const tif = opt.tif || DEFAULTS.tif;
const leverage = Number(opt.lev ?? DEFAULTS.leverage);
const riskPct = opt.risk != null ? Number(opt.risk) : DEFAULTS.riskPct;
const rr = opt.rr != null ? Number(opt.rr) : DEFAULTS.rr;

if (!symbol) fail('Missing --symbol');
if (!side) fail('Missing/invalid --side (use Buy/Sell or long/short)');
if (!entry || entry <= 0) fail('Missing/invalid --entry');
if (type === 'Limit' && !opt.entry) fail('Limit order needs --entry price');

// ---- defaults for SL / TP --------------------------------------------------
const isLong = side === 'Buy';
let sl = opt.sl != null ? Number(opt.sl) : (isLong ? entry * (1 - DEFAULTS.slPct / 100) : entry * (1 + DEFAULTS.slPct / 100));
let tp = opt.tp != null ? Number(opt.tp) : null;

// SL must sit on the losing side of entry.
if (isLong && sl >= entry) fail(`Long SL (${sl}) must be below entry (${entry})`);
if (!isLong && sl <= entry) fail(`Short SL (${sl}) must be above entry (${entry})`);

const priceRisk = Math.abs(entry - sl);
if (tp == null) tp = isLong ? entry + rr * priceRisk : entry - rr * priceRisk;
if (isLong && tp <= entry) fail(`Long TP (${tp}) must be above entry (${entry})`);
if (!isLong && tp >= entry) fail(`Short TP (${tp}) must be below entry (${entry})`);

// ---- precision from instrument info ---------------------------------------
function decimals(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
function roundStep(v, step, mode = 'round') {
  const d = decimals(step);
  return Number((Math[mode](v / step) * step).toFixed(d));
}

const info = await call(getClient().getInstrumentsInfo({ category: 'linear', symbol }));
if (!info.success || !info.result?.list?.length) fail(`Instrument not found: ${symbol}`, { detail: info.error });
const inst = info.result.list[0];
const qtyStep = Number(inst.lotSizeFilter.qtyStep);
const minQty = Number(inst.lotSizeFilter.minOrderQty);
const tick = Number(inst.priceFilter.tickSize);
const maxLev = Number(inst.leverageFilter?.maxLeverage ?? 100);

const entryR = roundStep(entry, tick);
const slR = roundStep(sl, tick);
const tpR = roundStep(tp, tick);

// ---- equity & risk amount --------------------------------------------------
let equity = 0, available = 0, equityKnown = false;
if (hasCredentials()) {
  const w = await call(getClient().getWalletBalance({ accountType: 'UNIFIED' }));
  if (w.success && w.result?.list?.length) {
    equity = Number(w.result.list[0].totalEquity) || 0;
    available = Number(w.result.list[0].totalAvailableBalance) || 0;
    equityKnown = true;
  }
}

let riskAmount;
if (opt['risk-usdt'] != null) riskAmount = Number(opt['risk-usdt']);
else if (equityKnown && equity > 0) riskAmount = equity * (riskPct / 100);
else fail('Cannot size position: equity is 0/unknown. Deposit funds or pass --risk-usdt.', { equityKnown, equity });

// ---- position sizing -------------------------------------------------------
let qty = roundStep(riskAmount / priceRisk, qtyStep, 'floor');
const notional = qty * entryR;
const requiredMargin = notional / leverage;

// ---- guardrails ------------------------------------------------------------
const warnings = [];
const errors = [];
if (qty < minQty) errors.push(`Computed qty ${qty} < exchange min ${minQty}. Tighten the SL (smaller entry→SL distance) or increase risk.`);
if (leverage > maxLev) errors.push(`Leverage ${leverage}x exceeds ${symbol} max ${maxLev}x.`);
if (leverage > DEFAULTS.leverage) warnings.push(`Leverage ${leverage}x is above the ${DEFAULTS.leverage}x default — extra liquidation risk.`);
const slDistPct = (priceRisk / entry) * 100;
const approxLiqPct = (1 / leverage) * 100 - 0.5; // rough, excludes fees/maintenance margin
if (slDistPct >= approxLiqPct) errors.push(`SL distance ${slDistPct.toFixed(1)}% is beyond approx liquidation ${approxLiqPct.toFixed(1)}% at ${leverage}x. Lower leverage or tighten SL.`);
if (equityKnown && requiredMargin > available) warnings.push(`Required margin ${requiredMargin.toFixed(2)} > available ${available.toFixed(2)} USDT.`);
if (riskPct > 5 && opt['risk-usdt'] == null) warnings.push(`Risk ${riskPct}% per trade is high (>5%).`);

// --- shared risk policy gate (risk_rules.json) ---
const rules = readRules();
const effRiskPct = (equityKnown && equity > 0)
  ? (riskAmount / equity) * 100
  : (opt['risk-usdt'] == null ? riskPct : null);
if (rules.maxRiskPerTradePct != null && effRiskPct != null && effRiskPct > rules.maxRiskPerTradePct + 1e-9)
  errors.push(`Risk ${effRiskPct.toFixed(2)}% exceeds risk_rules.json maxRiskPerTradePct ${rules.maxRiskPerTradePct}%.`);
if (rules.maxLeverage != null && leverage > rules.maxLeverage)
  errors.push(`Leverage ${leverage}x exceeds risk_rules.json maxLeverage ${rules.maxLeverage}x.`);

const plan = {
  ok: errors.length === 0,
  dryRun: !opt.confirm,
  network: getConfig().testnet ? 'testnet' : 'mainnet',
  symbol, side, orderType: type, timeInForce: tif,
  entry: entryR, stopLoss: slR, takeProfit: tpR,
  qty, notionalUSDT: Number(notional.toFixed(2)),
  leverage, requiredMarginUSDT: Number(requiredMargin.toFixed(2)),
  riskUSDT: Number(riskAmount.toFixed(2)),
  riskPctOfEquity: equityKnown && equity > 0 ? Number(((riskAmount / equity) * 100).toFixed(2)) : null,
  rewardUSDT: Number((qty * Math.abs(tpR - entryR)).toFixed(2)),
  riskReward: Number((Math.abs(tpR - entryR) / priceRisk).toFixed(2)),
  slDistancePct: Number(slDistPct.toFixed(2)),
  equityUSDT: equityKnown ? Number(equity.toFixed(2)) : null,
  availableUSDT: equityKnown ? Number(available.toFixed(2)) : null,
  policy: { maxRiskPerTradePct: rules.maxRiskPerTradePct ?? null, maxLeverage: rules.maxLeverage ?? null },
  warnings, errors,
};

// ---- dry-run: print plan and stop -----------------------------------------
if (!opt.confirm) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(plan.ok ? 0 : 1);
}

// ---- live execution (only with --confirm) ---------------------------------
if (!plan.ok) fail('Refusing to place order — guardrail errors present.', { plan });
if (!hasCredentials()) fail('No API credentials — cannot place order.');

const exec = { plan, steps: {} };

// 1) leverage (ignore "not modified" error 110043)
const lev = await call(getClient().setLeverage({ category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) }));
exec.steps.setLeverage = lev.success ? 'ok' : (lev.retCode === 110043 ? 'unchanged' : `error: ${lev.error}`);

// 2) entry order with attached SL/TP (full position TP/SL)
const orderParams = {
  category: 'linear', symbol, side, orderType: type,
  qty: String(qty), timeInForce: tif,
  takeProfit: String(tpR), stopLoss: String(slR), tpslMode: 'Full', positionIdx: 0,
};
if (type === 'Limit') orderParams.price = String(entryR);
const ord = await call(getClient().submitOrder(orderParams));
exec.steps.submitOrder = ord.success ? ord.result : `error: ${ord.error}`;
exec.ok = ord.success;

console.log(JSON.stringify(exec, null, 2));
process.exit(ord.success ? 0 : 1);
