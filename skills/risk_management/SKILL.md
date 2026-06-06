---
name: risk_management
description: Use when someone asks about risk management, account risk, total exposure, how much is at risk, whether a trade is allowed, position sizing limits, or to view/change risk rules and limits for Bybit trading.
argument-hint: [--action audit|check|rules] [--risk-pct N --leverage L] [--set key=value]
allowed-tools: Bash, Read, mcp__bybit__bybit_get_wallet_balance, mcp__bybit__bybit_get_positions
---

## What This Skill Does

The risk policy layer for the trading system. It owns the shared rules file and does two jobs:
1. **Audit** — assess the live account against the rules (open risk, exposure, aggregate leverage, distance to liquidation, uncapped positions).
2. **Pre-trade check** — decide whether a proposed trade is allowed under the rules.

Rules live in **`risk_rules.json`** at the project root — a single source of truth. **`place_trade` enforces this file as a hard gate**: any trade that breaches `maxRiskPerTradePct` or `maxLeverage` is refused (shown in its dry-run `errors`, blocked on `--confirm`).

**⚠️ MAINNET — REAL FUNDS.** See [[bybit-mcp-mainnet]]. This skill is read-only except for `rules --set`; it never places orders.

Engine: [risk_management.js](risk_management.js).

## The Rules (`risk_rules.json`)

| Key | Meaning |
|---|---|
| `maxRiskPerTradePct` | Max % of equity risked on one trade (entry→SL) |
| `maxLeverage` | Max leverage per position |
| `maxConcurrentPositions` | Max simultaneous open positions |
| `maxTotalOpenRiskPct` | Max summed risk of all open positions |
| `dailyLossLimitPct` | Halt trading after this much realized loss today |

`null` = rule disabled. Percentages are of account equity. **Live values are in `risk_rules.json`** (single source of truth — read at runtime, never hardcoded here). To see the current numbers, run `--action rules`.

## Actions

### `audit` (default) — account risk report
```bash
node "skills/risk_management/risk_management.js"
```
Returns `status` (OK / WARN / BREACH), equity, exposure, aggregate leverage, `totalOpenRiskPct`, `dailyRealizedPnl`/`dailyPnlPct` (since 00:00 UTC), per-position risk, plus `violations` and `warnings`. Summarize the status and ALWAYS relay violations/warnings (uncapped positions, near-liquidation, daily-loss-limit hit, rule breaches).

### `check` — pre-trade gate
```bash
node "skills/risk_management/risk_management.js" --action check --risk-pct 8 --leverage 10
```
Returns `allow: true/false` with `reasons`, evaluating the proposed trade against ALL rules: per-trade risk, leverage, position count, **projected total open risk** (current + this trade), and the **daily loss limit** (denies if already hit today). Use this when the user asks "can I take this trade?" before sizing it. (`place_trade` enforces `maxRiskPerTradePct` and `maxLeverage` automatically; the count/total-risk/daily-loss rules are evaluated here — run `check` before opening additional positions.)

### `rules` — view or edit limits
```bash
node "skills/risk_management/risk_management.js" --action rules
node "skills/risk_management/risk_management.js" --action rules --set maxRiskPerTradePct=3 --set maxConcurrentPositions=4
```
`--set key=value` writes back to `risk_rules.json` (use `null` to disable a rule). **Changing limits affects what `place_trade` will allow — confirm intentional edits with the user before writing.**

## Workflow

- **"What's my risk / audit my account"** → run `audit`, report status + violations + per-position risk.
- **"Can I take this trade?"** → run `check` with the proposed `--risk-pct` and `--leverage`; report allow/deny + reasons.
- **"Change my risk limit to X"** → confirm the change, then run `rules --set ...`, and note it now gates `place_trade`.

## Notes

- This skill defines and reports limits; `place_trade` and `manage_position` execute. Keep that separation.
- Editing `risk_rules.json` is the only write this skill makes — always confirm before changing a limit, since it loosens/tightens the live trading gate.
- Risk is measured entry→stop-loss. Positions without a stop-loss are flagged as **uncapped risk** in the audit.
- The daily loss limit uses **realized** P&L (closed trades) since 00:00 UTC, as a % of current equity. It halts new trades for the rest of the UTC day once hit.
- If equity is 0, audit still runs (everything zero); pre-trade `check` with `--risk-usdt` needs equity > 0 to compute a %.
