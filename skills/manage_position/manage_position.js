// manage_position — view & manage open Bybit perp positions.
// Reuses credentials/client from bybit-mcp (../../bybit-mcp/src/client.js).
//
// Actions:
//   view       (default, read-only) list positions + metrics + suggestions
//   close      reduce-only MARKET close (full or --pct / --qty)
//   sltp       set/modify stop-loss and/or take-profit
//   breakeven  move stop-loss to entry (optional --offset favorable %)
//   trail      set a trailing stop (--distance in price)
//
// SAFE BY DEFAULT: mutating actions (close/sltp/breakeven/trail) only print a
// plan unless --confirm is passed. `view` is always read-only.
//
// Usage examples:
//   node manage_position.js
//   node manage_position.js --action close --symbol BTCUSDT --pct 50
//   node manage_position.js --action sltp --symbol BTCUSDT --sl 58000 --tp 66000 --confirm
//   node manage_position.js --action breakeven --symbol BTCUSDT --confirm
//   node manage_position.js --action trail --symbol BTCUSDT --distance 800 --confirm

import { getClient, call, getConfig, hasCredentials } from '../../bybit-mcp/src/client.js';

const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (k === '--confirm') opt.confirm = true;
  else if (k.startsWith('--')) opt[k.slice(2)] = a[++i];
}
const action = (opt.action || 'view').toLowerCase();
const symbol = opt.symbol ? opt.symbol.toUpperCase() : null;

function out(o, code = 0) { console.log(JSON.stringify(o, null, 2)); process.exit(code); }
function fail(msg, extra = {}) { out({ ok: false, action, error: msg, ...extra }, 1); }

if (!hasCredentials()) fail('No Bybit API credentials. Set bybit-mcp/.env.');

// ---- precision helpers -----------------------------------------------------
function decimals(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
function roundStep(v, step, mode = 'round') {
  const d = decimals(step);
  return Number((Math[mode](v / step) * step).toFixed(d));
}
async function instrument(sym) {
  const i = await call(getClient().getInstrumentsInfo({ category: 'linear', symbol: sym }));
  if (!i.success || !i.result?.list?.length) return null;
  const f = i.result.list[0];
  return { qtyStep: Number(f.lotSizeFilter.qtyStep), minQty: Number(f.lotSizeFilter.minOrderQty), tick: Number(f.priceFilter.tickSize) };
}

async function getPositions(sym) {
  const params = { category: 'linear' };
  if (sym) params.symbol = sym; else params.settleCoin = 'USDT';
  const p = await call(getClient().getPositionInfo(params));
  if (!p.success) fail('Failed to fetch positions', { detail: p.error });
  return (p.result.list || []).filter((x) => Number(x.size) > 0);
}

async function fundingFor(sym) {
  const t = await call(getClient().getTickers({ category: 'linear', symbol: sym }));
  if (!t.success || !t.result?.list?.length) return null;
  return Number(t.result.list[0].fundingRate) * 100; // %
}

function describe(p, funding) {
  const long = p.side === 'Buy';
  const entry = Number(p.avgPrice), mark = Number(p.markPrice), liq = Number(p.liqPrice || 0);
  const sl = Number(p.stopLoss || 0), tp = Number(p.takeProfit || 0);
  const move = long ? mark - entry : entry - mark;
  const rUnit = sl > 0 ? Math.abs(entry - sl) : null;
  const rMultiple = rUnit ? move / rUnit : null;
  const liqDistPct = liq > 0 ? (Math.abs(mark - liq) / mark) * 100 : null;

  const suggestions = [];
  if (!sl) suggestions.push('No stop-loss set — set one to cap risk (--action sltp --sl ...).');
  if (rMultiple != null && rMultiple >= 1 && sl > 0) {
    const slBeyondBE = long ? sl < entry : sl > entry;
    if (slBeyondBE) suggestions.push(`In profit ${rMultiple.toFixed(1)}R — consider moving SL to breakeven (--action breakeven).`);
  }
  if (liqDistPct != null && liqDistPct < 15) suggestions.push(`Close to liquidation (${liqDistPct.toFixed(1)}% from mark).`);
  if (funding != null) {
    if (long && funding >= 0.05) suggestions.push(`Paying high funding (+${funding.toFixed(3)}%/8h) holding long.`);
    if (!long && funding <= -0.05) suggestions.push(`Paying high funding (${funding.toFixed(3)}%/8h) holding short.`);
  }

  return {
    symbol: p.symbol, side: p.side, size: Number(p.size), leverage: Number(p.leverage),
    entry, mark, liqPrice: liq || null,
    stopLoss: sl || null, takeProfit: tp || null, trailingStop: Number(p.trailingStop || 0) || null,
    unrealisedPnl: Number(p.unrealisedPnl), positionValue: Number(p.positionValue),
    pnlPct: Number(((move / entry) * 100).toFixed(2)),
    rMultiple: rMultiple != null ? Number(rMultiple.toFixed(2)) : null,
    liqDistancePct: liqDistPct != null ? Number(liqDistPct.toFixed(2)) : null,
    fundingPct: funding != null ? Number(funding.toFixed(4)) : null,
    suggestions,
  };
}

// ---- VIEW ------------------------------------------------------------------
if (action === 'view') {
  const positions = await getPositions(symbol);
  const enriched = [];
  for (const p of positions) enriched.push(describe(p, await fundingFor(p.symbol)));
  out({
    ok: true, action: 'view', network: getConfig().testnet ? 'testnet' : 'mainnet',
    count: enriched.length, positions: enriched,
  });
}

// All other actions mutate a single symbol's position.
if (!symbol) fail(`--symbol is required for action "${action}"`);
const positions = await getPositions(symbol);
const pos = positions[0];
if (!pos) fail(`No open position for ${symbol}`);
const long = pos.side === 'Buy';
const entry = Number(pos.avgPrice), mark = Number(pos.markPrice), size = Number(pos.size);
const inst = await instrument(symbol);
if (!inst) fail(`Instrument not found: ${symbol}`);

// ---- CLOSE -----------------------------------------------------------------
if (action === 'close') {
  const pct = opt.pct != null ? Number(opt.pct) : 100;
  let qty = opt.qty != null ? Number(opt.qty) : size * (pct / 100);
  qty = roundStep(qty, inst.qtyStep, 'floor');
  if (qty <= 0) fail('Close qty rounds to 0.');
  if (qty > size) qty = size;
  const closeSide = long ? 'Sell' : 'Buy';
  const estPnl = (long ? mark - entry : entry - mark) * qty;
  const plan = {
    ok: true, action: 'close', dryRun: !opt.confirm, network: getConfig().testnet ? 'testnet' : 'mainnet',
    symbol, positionSide: pos.side, closeSide, closeQty: qty, ofSize: size,
    pctClosed: Number(((qty / size) * 100).toFixed(1)), markPrice: mark, estRealizedPnl: Number(estPnl.toFixed(2)),
  };
  if (!opt.confirm) out(plan);
  const o = await call(getClient().submitOrder({
    category: 'linear', symbol, side: closeSide, orderType: 'Market',
    qty: String(qty), reduceOnly: true, positionIdx: 0,
  }));
  out({ ...plan, dryRun: false, result: o.success ? o.result : `error: ${o.error}`, ok: o.success }, o.success ? 0 : 1);
}

// ---- SLTP ------------------------------------------------------------------
if (action === 'sltp') {
  const sl = opt.sl != null ? roundStep(Number(opt.sl), inst.tick) : null;
  const tp = opt.tp != null ? roundStep(Number(opt.tp), inst.tick) : null;
  if (sl == null && tp == null) fail('Provide --sl and/or --tp.');
  if (sl != null && (long ? sl >= entry : sl <= entry)) fail(`SL ${sl} on wrong side of entry ${entry} for ${pos.side}.`);
  if (tp != null && (long ? tp <= entry : tp >= entry)) fail(`TP ${tp} on wrong side of entry ${entry} for ${pos.side}.`);
  const plan = { ok: true, action: 'sltp', dryRun: !opt.confirm, symbol, entry, newStopLoss: sl, newTakeProfit: tp };
  if (!opt.confirm) out(plan);
  const params = { category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full' };
  if (sl != null) params.stopLoss = String(sl);
  if (tp != null) params.takeProfit = String(tp);
  const r = await call(getClient().setTradingStop(params));
  out({ ...plan, dryRun: false, result: r.success ? 'ok' : `error: ${r.error}`, ok: r.success }, r.success ? 0 : 1);
}

// ---- BREAKEVEN -------------------------------------------------------------
if (action === 'breakeven') {
  const offsetPct = opt.offset != null ? Number(opt.offset) : 0;
  const be = roundStep(long ? entry * (1 + offsetPct / 100) : entry * (1 - offsetPct / 100), inst.tick);
  // Only valid if price has moved enough that BE is on the safe side of mark.
  if (long && be >= mark) fail(`Cannot set BE ${be} at/above mark ${mark} — price hasn't moved up enough.`);
  if (!long && be <= mark) fail(`Cannot set BE ${be} at/below mark ${mark} — price hasn't moved down enough.`);
  const plan = { ok: true, action: 'breakeven', dryRun: !opt.confirm, symbol, entry, mark, newStopLoss: be };
  if (!opt.confirm) out(plan);
  const r = await call(getClient().setTradingStop({ category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full', stopLoss: String(be) }));
  out({ ...plan, dryRun: false, result: r.success ? 'ok' : `error: ${r.error}`, ok: r.success }, r.success ? 0 : 1);
}

// ---- TRAIL -----------------------------------------------------------------
if (action === 'trail') {
  if (opt.distance == null) fail('Provide --distance (trailing distance in price, e.g. 800).');
  const dist = roundStep(Number(opt.distance), inst.tick);
  if (dist <= 0) fail('Trailing distance must be > 0.');
  const plan = { ok: true, action: 'trail', dryRun: !opt.confirm, symbol, trailingDistance: dist };
  if (!opt.confirm) out(plan);
  const r = await call(getClient().setTradingStop({ category: 'linear', symbol, positionIdx: 0, trailingStop: String(dist) }));
  out({ ...plan, dryRun: false, result: r.success ? 'ok' : `error: ${r.error}`, ok: r.success }, r.success ? 0 : 1);
}

fail(`Unknown action "${action}". Use view|close|sltp|breakeven|trail.`);
