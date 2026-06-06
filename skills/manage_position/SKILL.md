---
name: manage_position
description: Use when someone asks to manage a position, check open positions, see unrealized PnL, close a trade, take partial profit, adjust SL/TP, move stop to breakeven, or set a trailing stop on Bybit.
argument-hint: [--action view|close|sltp|breakeven|trail] [--symbol BTCUSDT] [--pct 50 | --sl ... --tp ... | --distance ...]
allowed-tools: Bash, Read, mcp__bybit__bybit_get_positions, mcp__bybit__bybit_get_ticker, mcp__bybit__bybit_get_wallet_balance
---

## What This Skill Does

Views and manages **open** Bybit USDT-perp positions: see PnL, close (full or partial), adjust SL/TP, move stop to breakeven, or set a trailing stop. It is proactive — when viewing, it surfaces suggestions (move to breakeven at ≥1R, near-liquidation, high funding).

**⚠️ MAINNET — REAL FUNDS.** See [[bybit-mcp-mainnet]]. Mutating actions NEVER run without explicit user confirmation in the same turn.

Engine: [manage_position.js](manage_position.js). Mutating actions are **dry-run by default**; they execute only with `--confirm`. `view` is always read-only.

## Actions

| Action | What it does | Order/Call |
|---|---|---|
| `view` (default) | List positions: entry, size, lev, mark, uPnL, R-multiple, dist to liq, funding, + suggestions | read-only |
| `close` | Reduce-only **MARKET** close, full or `--pct`/`--qty` | submitOrder reduceOnly |
| `sltp` | Set/modify `--sl` and/or `--tp` | setTradingStop |
| `breakeven` | Move SL to entry (optional `--offset` % favorable for fees) | setTradingStop |
| `trail` | Set trailing stop `--distance` (price distance) | setTradingStop |

## Workflow

### Viewing (safe, no confirmation)
Run from project root:
```bash
node "skills/manage_position/manage_position.js"                    # all positions
node "skills/manage_position/manage_position.js" --symbol BTCUSDT   # one symbol
```
Summarize each position in a compact table (symbol, side, size, entry, mark, uPnL, R, liq dist). **Always relay the `suggestions`** for each position — that's the proactive value.

### Mutating (close / sltp / breakeven / trail) — ALWAYS dry-run → confirm → execute
1. **Dry-run** the action (no `--confirm`) and read the plan JSON.
   ```bash
   node "skills/manage_position/manage_position.js" --action close --symbol BTCUSDT --pct 50
   ```
2. **Present the plan** to the user in one line, e.g.:
   > `Close 50% of BTCUSDT long: Sell 0.008 @ market · est PnL +$X`
   > `Move SL → 60000 (breakeven) on BTCUSDT long`
   Surface any error and stop if the plan is invalid.
3. **Get an explicit yes.** Don't act on a vague reply.
4. **Execute** by re-running the exact command with `--confirm` appended. Report the result (orderId / ok).
5. After a mutation, optionally re-run `view` to show the updated state.

## Proactive Suggestions (from `view`)

The engine emits these in each position's `suggestions`; relay them:
- No stop-loss set → urge setting one.
- In profit ≥ 1R with SL still beyond breakeven → suggest `breakeven`.
- Mark within 15% of liquidation → warn.
- Holding against high funding (≥0.05%/8h) → note the cost.

## Notes & Guardrails

- **Dry-run unless `--confirm`.** No accidental closes or stop changes.
- `close` uses reduce-only market orders (can only reduce, never flip the position).
- SL/TP are validated to be on the correct side of entry; breakeven refuses if price hasn't moved past entry yet.
- Close qty is floored to the exchange `qtyStep`; clamped to current size.
- Never append `--confirm` without an explicit user yes in the same turn — the single most important rule.
- This skill manages existing positions only. To open one, use `place_trade`; to scan, use `scan_market`.
