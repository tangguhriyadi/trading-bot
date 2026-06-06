// risk_management — shared risk policy: audit the account and pre-check trades.
// Reads/writes risk_rules.json at the project root (shared with place_trade).
//
// Actions:
//   audit (default)  Assess current account vs rules: open risk, exposure,
//                    leverage, position count, distance to liquidation.
//   check            Pre-trade gate: validate a proposed trade vs the rules.
//                    --risk-pct N | --risk-usdt N, --leverage L
//   rules            Print rules; with one or more --set key=value, update them.
//
// Usage:
//   node risk_management.js
//   node risk_management.js --action check --risk-pct 8 --leverage 10
//   node risk_management.js --action rules --set maxRiskPerTradePct=3 --set maxLeverage=5

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient, call, getConfig, hasCredentials } from '../../bybit-mcp/src/client.js';

const RULES_PATH = join(import.meta.dirname, '..', '..', 'risk_rules.json');
function readRules() { try { return JSON.parse(readFileSync(RULES_PATH, 'utf8')); } catch { return {}; } }
function writeRules(r) { writeFileSync(RULES_PATH, JSON.stringify(r, null, 2) + '\n'); }

// ---- arg parsing (collect repeated --set) ----------------------------------
const a = process.argv.slice(2);
const opt = { set: [] };
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (k === '--set') opt.set.push(a[++i]);
  else if (k.startsWith('--')) opt[k.slice(2)] = a[++i];
}
const action = (opt.action || 'audit').toLowerCase();
function out(o, code = 0) { console.log(JSON.stringify(o, null, 2)); process.exit(code); }

const rules = readRules();

// ---- RULES (view / edit) ---------------------------------------------------
if (action === 'rules') {
  if (opt.set.length) {
    for (const pair of opt.set) {
      const [key, raw] = pair.split('=');
      if (!(key in rules)) out({ ok: false, error: `Unknown rule key "${key}". Valid: ${Object.keys(rules).filter((k) => !k.startsWith('_')).join(', ')}` }, 1);
      rules[key] = raw === 'null' ? null : Number(raw);
    }
    writeRules(rules);
    out({ ok: true, action: 'rules', updated: true, rules });
  }
  out({ ok: true, action: 'rules', rules });
}

if (!hasCredentials()) out({ ok: false, action, error: 'No Bybit API credentials. Set bybit-mcp/.env.' }, 1);

// ---- shared account snapshot ----------------------------------------------
async function snapshot() {
  const w = await call(getClient().getWalletBalance({ accountType: 'UNIFIED' }));
  const equity = w.success && w.result?.list?.length ? Number(w.result.list[0].totalEquity) || 0 : 0;
  const available = w.success && w.result?.list?.length ? Number(w.result.list[0].totalAvailableBalance) || 0 : 0;
  const p = await call(getClient().getPositionInfo({ category: 'linear', settleCoin: 'USDT' }));
  const positions = (p.success ? p.result.list : []).filter((x) => Number(x.size) > 0);
  return { equity, available, positions };
}

// Summed risk (entry→SL) of all open positions, as % of equity. Ignores uncapped.
function openRiskPct(positions, equity) {
  if (!(equity > 0)) return null;
  const capped = positions.reduce((s, p) => {
    const sl = Number(p.stopLoss || 0);
    return sl > 0 ? s + Math.abs(Number(p.avgPrice) - sl) * Number(p.size) : s;
  }, 0);
  return Number(((capped / equity) * 100).toFixed(2));
}

// Realized P&L since 00:00 UTC today (linear), used for the daily loss limit.
async function dailyRealizedPnl() {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const r = await call(getClient().getClosedPnL({ category: 'linear', startTime: start.getTime(), limit: 100 }));
  if (!r.success) return null;
  return (r.result.list || []).reduce((s, x) => s + Number(x.closedPnl || 0), 0);
}

// ---- CHECK (pre-trade gate) ------------------------------------------------
if (action === 'check') {
  const { equity, positions } = await snapshot();
  let riskPct = opt['risk-pct'] != null ? Number(opt['risk-pct']) : null;
  if (riskPct == null && opt['risk-usdt'] != null) {
    if (equity > 0) riskPct = (Number(opt['risk-usdt']) / equity) * 100;
    else out({ ok: false, action: 'check', allow: false, reason: 'Equity is 0 — cannot evaluate --risk-usdt as a %.' }, 1);
  }
  const leverage = opt.leverage != null ? Number(opt.leverage) : null;
  const curOpenRiskPct = openRiskPct(positions, equity);
  const dailyPnl = await dailyRealizedPnl();
  const dailyPnlPct = dailyPnl != null && equity > 0 ? Number(((dailyPnl / equity) * 100).toFixed(2)) : null;
  const reasons = [];
  if (rules.maxRiskPerTradePct != null && riskPct != null && riskPct > rules.maxRiskPerTradePct + 1e-9)
    reasons.push(`risk ${riskPct.toFixed(2)}% > maxRiskPerTradePct ${rules.maxRiskPerTradePct}%`);
  if (rules.maxLeverage != null && leverage != null && leverage > rules.maxLeverage)
    reasons.push(`leverage ${leverage}x > maxLeverage ${rules.maxLeverage}x`);
  if (rules.maxConcurrentPositions != null && positions.length + 1 > rules.maxConcurrentPositions)
    reasons.push(`would be ${positions.length + 1} positions > maxConcurrentPositions ${rules.maxConcurrentPositions}`);
  if (rules.maxTotalOpenRiskPct != null && curOpenRiskPct != null && riskPct != null && (curOpenRiskPct + riskPct) > rules.maxTotalOpenRiskPct + 1e-9)
    reasons.push(`total open risk would be ${(curOpenRiskPct + riskPct).toFixed(2)}% > maxTotalOpenRiskPct ${rules.maxTotalOpenRiskPct}%`);
  if (rules.dailyLossLimitPct != null && dailyPnlPct != null && dailyPnlPct <= -rules.dailyLossLimitPct)
    reasons.push(`daily loss ${dailyPnlPct}% has hit dailyLossLimitPct ${rules.dailyLossLimitPct}% — trading halted today`);
  out({
    ok: true, action: 'check', allow: reasons.length === 0,
    evaluated: {
      riskPct: riskPct != null ? Number(riskPct.toFixed(2)) : null, leverage,
      openPositions: positions.length, currentOpenRiskPct: curOpenRiskPct, dailyRealizedPnl: dailyPnl != null ? Number(dailyPnl.toFixed(2)) : null, dailyPnlPct,
    },
    rules, reasons,
  });
}

// ---- AUDIT (default) -------------------------------------------------------
if (action === 'audit') {
  const { equity, available, positions } = await snapshot();
  const perPosition = positions.map((p) => {
    const long = p.side === 'Buy';
    const entry = Number(p.avgPrice), mark = Number(p.markPrice), size = Number(p.size);
    const sl = Number(p.stopLoss || 0), liq = Number(p.liqPrice || 0);
    const riskUSDT = sl > 0 ? Math.abs(entry - sl) * size : null; // null = uncapped (no SL)
    return {
      symbol: p.symbol, side: p.side, size, leverage: Number(p.leverage),
      notionalUSDT: Number(Number(p.positionValue).toFixed(2)),
      unrealisedPnl: Number(p.unrealisedPnl),
      stopLoss: sl || null,
      riskIfStopped: riskUSDT != null ? Number(riskUSDT.toFixed(2)) : null,
      riskPctOfEquity: riskUSDT != null && equity > 0 ? Number(((riskUSDT / equity) * 100).toFixed(2)) : null,
      liqDistancePct: liq > 0 ? Number(((Math.abs(mark - liq) / mark) * 100).toFixed(2)) : null,
      uncappedRisk: sl <= 0,
    };
  });

  const exposure = perPosition.reduce((s, p) => s + p.notionalUSDT, 0);
  const cappedRisk = perPosition.reduce((s, p) => s + (p.riskIfStopped || 0), 0);
  const totalOpenRiskPct = equity > 0 ? Number(((cappedRisk / equity) * 100).toFixed(2)) : null;
  const aggLeverage = equity > 0 ? Number((exposure / equity).toFixed(2)) : null;
  const uncapped = perPosition.filter((p) => p.uncappedRisk).map((p) => p.symbol);

  const violations = [], warnings = [];
  for (const p of perPosition) {
    if (rules.maxRiskPerTradePct != null && p.riskPctOfEquity != null && p.riskPctOfEquity > rules.maxRiskPerTradePct)
      violations.push(`${p.symbol}: risk ${p.riskPctOfEquity}% > maxRiskPerTradePct ${rules.maxRiskPerTradePct}%`);
    if (rules.maxLeverage != null && p.leverage > rules.maxLeverage)
      violations.push(`${p.symbol}: leverage ${p.leverage}x > maxLeverage ${rules.maxLeverage}x`);
    if (p.liqDistancePct != null && p.liqDistancePct < 15)
      warnings.push(`${p.symbol}: ${p.liqDistancePct}% from liquidation`);
  }
  if (uncapped.length) warnings.push(`No stop-loss (uncapped risk): ${uncapped.join(', ')}`);
  if (rules.maxConcurrentPositions != null && positions.length > rules.maxConcurrentPositions)
    violations.push(`${positions.length} positions > maxConcurrentPositions ${rules.maxConcurrentPositions}`);
  if (rules.maxTotalOpenRiskPct != null && totalOpenRiskPct != null && totalOpenRiskPct > rules.maxTotalOpenRiskPct)
    violations.push(`total open risk ${totalOpenRiskPct}% > maxTotalOpenRiskPct ${rules.maxTotalOpenRiskPct}%`);

  const dailyPnl = await dailyRealizedPnl();
  const dailyPnlPct = dailyPnl != null && equity > 0 ? Number(((dailyPnl / equity) * 100).toFixed(2)) : null;
  if (rules.dailyLossLimitPct != null && dailyPnlPct != null && dailyPnlPct <= -rules.dailyLossLimitPct)
    violations.push(`daily loss ${dailyPnlPct}% <= -dailyLossLimitPct ${rules.dailyLossLimitPct}% — halt trading today`);

  const status = violations.length ? 'BREACH' : (warnings.length || uncapped.length) ? 'WARN' : 'OK';
  out({
    ok: true, action: 'audit', network: getConfig().testnet ? 'testnet' : 'mainnet', status,
    equityUSDT: Number(equity.toFixed(2)), availableUSDT: Number(available.toFixed(2)),
    positionCount: positions.length, exposureUSDT: Number(exposure.toFixed(2)),
    aggregateLeverage: aggLeverage, totalOpenRiskUSDT: Number(cappedRisk.toFixed(2)), totalOpenRiskPct,
    dailyRealizedPnl: dailyPnl != null ? Number(dailyPnl.toFixed(2)) : null, dailyPnlPct,
    rules, violations, warnings, perPosition,
  });
}

out({ ok: false, error: `Unknown action "${action}". Use audit|check|rules.` }, 1);
