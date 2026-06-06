---
name: place_trade
description: Use when someone asks to place a trade, open a position, enter a trade, buy/sell/long/short a coin on Bybit, set up an order with stop-loss and take-profit, or execute a setup from a market scan. Risk-based Bybit perpetual order with SL/TP/leverage.
argument-hint: SYMBOL Buy|Sell --entry PRICE [--sl PRICE] [--tp PRICE] [--risk 1] [--lev 10]
disable-model-invocation: true
allowed-tools: Bash, Read, mcp__bybit__bybit_get_wallet_balance, mcp__bybit__bybit_get_positions, mcp__bybit__bybit_get_ticker
---

## What This Skill Does

Places a **risk-based** order on Bybit USDT perpetuals with a full bracket: leverage + entry + stop-loss + take-profit. Position size is computed from your risk budget and stop distance — not guessed.

**⚠️ MAINNET — REAL FUNDS.** See [[bybit-mcp-mainnet]]. This skill NEVER places an order without explicit user confirmation in the same turn.

## Defaults

| Setting | Default |
|---|---|
| Risk per trade | 1% of equity (`--risk`) or absolute `--risk-usdt` |
| Stop-loss | 5% from entry (`--sl` to override) |
| Take-profit | 2R — twice the risk distance (`--tp` or `--rr`) |
| Leverage | 5x (`--lev`) |
| Order type | Limit (`--type Market` for market) |
| Category | linear (USDT perp), one-way mode |

Engine: [place_trade.js](place_trade.js). It is **dry-run by default** — it only places a real order when `--confirm` is passed.

## Workflow — ALWAYS dry-run, confirm, then execute

1. **Gather parameters.** Need at minimum: `symbol`, `side` (Buy/Sell or long/short), and `--entry` price (for Limit). SL/TP/risk/leverage fall back to defaults. If the trade comes from a `scan_market` pick, use its bias for side and its support/resistance for SL/TP.

2. **Run the DRY-RUN** (no `--confirm`) from the project root:
   ```bash
   node "skills/place_trade/place_trade.js" --symbol SYMBOL --side Buy --entry PRICE [--sl ...] [--tp ...] [--risk 1] [--lev 10]
   ```
   This prints a JSON plan: computed `qty`, `notionalUSDT`, `requiredMarginUSDT`, `riskUSDT`, `riskReward`, `slDistancePct`, plus `warnings` and `errors`. It does NOT touch the exchange.

3. **Present the plan to the user** as a one-line summary plus the key numbers:
   > `LONG 0.01 BTCUSDT @ 60000 limit · SL 57000 (-5%) · TP 66000 (2R) · 5x · risk $X (1%) · margin $Y`
   - Surface every `warning`. If there are `errors`, the plan is invalid — explain and stop (do NOT offer to confirm).
   - If `requiredMarginUSDT` > `availableUSDT`, flag it.

4. **Get explicit confirmation.** Ask the user to confirm (a clear "yes"/"ya"). Do not proceed on a vague reply.

5. **Execute** by re-running the EXACT same command with `--confirm` appended:
   ```bash
   node "skills/place_trade/place_trade.js" --symbol ... --confirm
   ```
   Report back the `setLeverage` result and the `submitOrder` result (orderId). If it errors, relay the message and do not retry blindly.

6. **Optionally verify** with `bybit_get_positions` to show the resulting open position.

## Guardrails (enforced by the engine)

- **Dry-run unless `--confirm`.** No accidental fills.
- SL must be on the losing side of entry (below for long, above for short) — else refused.
- `qty` rounded down to the exchange `qtyStep`; refused if below `minOrderQty`.
- Refused if SL distance is beyond the approx liquidation distance for the chosen leverage.
- Refused if leverage exceeds the symbol's max; warns if above the 10x default.
- Warns if required margin exceeds available balance, or risk > 5%.

## Notes

- Never call `--confirm` without an explicit user yes in the same turn. This is the single most important rule.
- `qty`, `price`, `leverage` are passed as strings to Bybit (the engine handles this).
- TP/SL are attached to the entry order as full-position TP/SL (`tpslMode: Full`, one-way `positionIdx: 0`).
- If equity is 0/unknown, sizing fails by design — deposit funds or pass `--risk-usdt` for a fixed risk amount.
- This skill only opens positions. To close/cancel, use the bybit MCP tools (`bybit_cancel_order`, or a reduce-only order).
