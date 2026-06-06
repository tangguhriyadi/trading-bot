// agent.js — automated trading orchestrator for the ai-agent-trader system.
//
// One execution = one cycle:
//   1. risk_management audit  → EXIT if status BREACH (incl. daily loss limit hit)
//   2. scan_market (1h)       → read ranked JSON
//   3. filter                 → LONG/SHORT candidates, skip NEUTRAL & already-open symbols,
//                               respect maxConcurrentPositions; ranked by conviction
//   4. place_trade dry-run    → try candidates in order; take the first that passes
//                               (fall through past blocked ones); SKIP if none pass
//   5. place_trade --confirm  → place the live order for the chosen pick, log the result
//
// Fully automated: no prompts, no manual input. Any unexpected error is logged
// and the process exits gracefully (never crashes).
//
// Modes:
//   node agent.js              LIVE — places real orders on MAINNET.
//   node agent.js --dry-run    Runs steps 1-4 and logs the planned order, but does
//                              NOT place a live order. Use this to test safely.
//
// Logs: logs/agent-YYYY-MM-DD.log (timestamped). A summary is printed to console.

import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = import.meta.dirname;
const DRY = process.argv.includes('--dry-run');

// ---- logging ---------------------------------------------------------------
const LOG_DIR = join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const TODAY = new Date().toISOString().slice(0, 10);
const LOG_FILE = join(LOG_DIR, `agent-${TODAY}.log`);

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* logging must never crash the agent */ }
  console.log(line);
}

const summary = {
  date: TODAY,
  mode: DRY ? 'DRY-RUN' : 'LIVE',
  action: 'NONE',
  coin: null,
  side: null,
  status: null,
  reason: null,
  orderId: null,
};

function finish(code) {
  console.log('\n===== AGENT SUMMARY =====');
  console.log(`Date    : ${summary.date}`);
  console.log(`Mode    : ${summary.mode}`);
  console.log(`Action  : ${summary.action}`);
  if (summary.coin) console.log(`Trade   : ${summary.side} ${summary.coin}`);
  if (summary.orderId) console.log(`OrderID : ${summary.orderId}`);
  console.log(`Status  : ${summary.status ?? '-'}`);
  if (summary.reason) console.log(`Reason  : ${summary.reason}`);
  console.log('=========================');
  process.exit(code);
}

// Run an engine script and parse its JSON stdout. Engines print pure JSON.
function runJSON(label, scriptRel, args) {
  const res = spawnSync(process.execPath, [join(ROOT, scriptRel), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  if (res.error) throw new Error(`${label}: spawn failed: ${res.error.message}`);
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`${label}: empty output${res.stderr ? ` (stderr: ${res.stderr.trim().slice(0, 200)})` : ''}`);
  try { return JSON.parse(out); }
  catch { throw new Error(`${label}: non-JSON output: ${out.slice(0, 200)}`); }
}

function readRules() {
  try { return JSON.parse(readFileSync(join(ROOT, 'risk_rules.json'), 'utf8')); } catch { return {}; }
}

// ---- main cycle ------------------------------------------------------------
try {
  log('INFO', `=== Agent start (mode=${summary.mode}) ===`);

  // STEP 1 — risk audit
  const audit = runJSON('audit', 'skills/risk_management/risk_management.js', ['--action', 'audit']);
  log('INFO', `Audit: status=${audit.status} equity=$${audit.equityUSDT} positions=${audit.positionCount} totalOpenRisk=${audit.totalOpenRiskPct}% dailyPnl=${audit.dailyPnlPct}%`);
  if (audit.violations?.length) log('WARN', `Violations: ${audit.violations.join(' | ')}`);
  if (audit.warnings?.length) log('WARN', `Warnings: ${audit.warnings.join(' | ')}`);
  if (audit.status === 'BREACH') {
    summary.action = 'EXIT';
    summary.status = 'BREACH';
    summary.reason = (audit.violations || []).join('; ') || 'risk breach';
    log('ERROR', 'Risk status BREACH — halting, no trades this cycle.');
    finish(0);
  }

  // position-count guard (place_trade does not check this; we must)
  const rules = readRules();
  const openSymbols = (audit.perPosition || []).map((p) => p.symbol);
  if (rules.maxConcurrentPositions != null && audit.positionCount >= rules.maxConcurrentPositions) {
    summary.action = 'SKIP';
    summary.status = 'OK';
    summary.reason = `at max concurrent positions (${audit.positionCount}/${rules.maxConcurrentPositions})`;
    log('INFO', summary.reason + ' — skip.');
    finish(0);
  }

  // STEP 2 — scan
  const scan = runJSON('scan', 'skills/scan_market/scan.js', ['--tf', '60']);
  log('INFO', `Scan: ${scan.scanned} symbols, ${scan.longs} long / ${scan.shorts} short. Report: ${scan.file}`);

  // STEP 3 — filter to one pick
  const candidates = (scan.top || [])
    .filter((c) => c.bias === 'LONG' || c.bias === 'SHORT')
    .filter((c) => !openSymbols.includes(c.symbol));
  if (!candidates.length) {
    summary.action = 'SKIP';
    summary.status = 'OK';
    summary.reason = (scan.top || []).length ? 'all candidates neutral or already open' : 'no LONG/SHORT setups';
    log('INFO', `No tradeable candidate — skip. (${summary.reason})`);
    finish(0);
  }
  log('INFO', `Candidates (by conviction): ${candidates.map((c) => `${c.symbol}/${c.bias}/${c.conviction}`).join(', ')}`);

  // STEP 4 — dry-run each candidate in order; take the first that passes (fall-through).
  let pick = null, side = null, tradeArgs = null, dry = null;
  for (const c of candidates) {
    const s = c.bias === 'LONG' ? 'Buy' : 'Sell';
    const args = ['--symbol', c.symbol, '--side', s, '--entry', String(c.price)];
    const d = runJSON('place_trade dry-run', 'skills/place_trade/place_trade.js', args);
    if (d.ok && !(d.errors && d.errors.length)) {
      pick = c; side = s; tradeArgs = args; dry = d;
      if (d.warnings?.length) log('WARN', `${c.symbol} dry-run warnings: ${d.warnings.join(' | ')}`);
      log('INFO', `Dry-run OK: ${s} ${c.symbol} qty=${d.qty} entry=${d.entry} SL=${d.stopLoss} TP=${d.takeProfit} lev=${d.leverage}x risk=$${d.riskUSDT}`);
      break;
    }
    log('WARN', `Skip ${c.symbol} (conviction=${c.conviction}): ${(d.errors || ['blocked']).join('; ')}`);
  }
  if (!pick) {
    summary.action = 'SKIP';
    summary.status = 'OK';
    summary.reason = 'all candidates blocked at dry-run';
    log('INFO', 'No candidate passed dry-run — skip, no trade.');
    finish(0);
  }
  summary.coin = pick.symbol;
  summary.side = side;

  // STEP 5 — execute (or stop here in dry-run mode)
  if (DRY) {
    summary.action = 'WOULD-TRADE';
    summary.status = 'DRY-RUN';
    summary.reason = `would ${side} ${dry.qty} ${pick.symbol} @ ${dry.entry} (SL ${dry.stopLoss} / TP ${dry.takeProfit})`;
    log('INFO', `[DRY-RUN] Not placing a live order. ${summary.reason}`);
    finish(0);
  }

  log('INFO', `Executing LIVE order: ${side} ${dry.qty} ${pick.symbol} @ ${dry.entry} ...`);
  const exec = runJSON('place_trade execute', 'skills/place_trade/place_trade.js', [...tradeArgs, '--confirm']);
  if (!exec.ok) {
    summary.action = 'EXIT';
    summary.status = 'ORDER-FAILED';
    summary.reason = typeof exec.steps?.submitOrder === 'string' ? exec.steps.submitOrder : (exec.error || 'order rejected');
    log('ERROR', `Order failed: ${summary.reason}`);
    finish(1);
  }
  const orderId = exec.steps?.submitOrder?.orderId || null;
  summary.action = 'TRADED';
  summary.status = 'ORDER PLACED';
  summary.orderId = orderId;
  log('INFO', `ORDER PLACED: id=${orderId} ${side} ${exec.plan.qty} ${pick.symbol} entry=${exec.plan.entry} SL=${exec.plan.stopLoss} TP=${exec.plan.takeProfit} leverage=${exec.plan.leverage}x`);
  finish(0);
} catch (err) {
  summary.status = 'ERROR';
  summary.reason = err?.message || String(err);
  log('ERROR', `Unexpected error: ${summary.reason}`);
  finish(1);
}
