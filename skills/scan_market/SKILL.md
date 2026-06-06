---
name: scan_market
description: Use when someone asks to scan the market, screen Bybit perps, find crypto trade setups, look for trading opportunities, or check which coins look bullish/bearish. Scans Bybit USDT perpetual futures and ranks setups.
argument-hint: [symbols... | --tf 60 | --bars 200]
allowed-tools: Bash, Read, Write, Glob, mcp__bybit__bybit_get_ticker, mcp__bybit__bybit_get_orderbook, mcp__bybit__bybit_get_wallet_balance, mcp__bybit__bybit_get_positions, mcp__bybit__bybit_place_order, mcp__bybit__bybit_set_leverage
---

## What This Skill Does

Scans Bybit USDT perpetual futures, scores each symbol for trade-worthiness using momentum/volume, technical indicators (RSI, MACD, EMA), funding rate / open interest context, and support/resistance levels — then produces a ranked markdown report and optionally proposes orders (always confirmed by the user first).

Data source: the `bybit-mcp` client (reuses credentials from `bybit-mcp/.env`). **Mainnet — real funds.**

## Context

- Scan engine: [scan.js](scan.js) — fetches tickers + klines from Bybit and computes all indicators in one pass. Run it; do NOT recompute indicators by hand.
- Default universe: ~18 liquid USDT perps (BTC, ETH, SOL, …). Override by passing symbols as arguments.
- Output reports: `output/scan_market/scan-<timestamp>.md` (written by the script).

## Workflow

1. **Run the scan.** From the project root:
   ```bash
   node "skills/scan_market/scan.js" $ARGUMENTS
   ```
   - No arguments → default watchlist, 1h timeframe, 200 bars.
   - `$ARGUMENTS` may contain custom symbols (e.g. `BTCUSDT SOLUSDT`) and/or flags `--tf <minutes>` and `--bars <n>`.
   - The script prints compact JSON (top picks + counts + report file path) to stdout and writes the full table to a markdown file.

2. **Read the JSON output.** It contains: `file`, `scanned`, `longs`, `shorts`, and `top` (up to 5 highest-conviction non-neutral setups, each with `bias`, `score`, `price`, `rsi`, `funding`, `support`, `resistance`, `signals`).

3. **Summarize in chat.** Show a short table of the top picks with bias, conviction score, price, and the key signals. State the report file path. Keep it tight — the full table already lives in the markdown file.

4. **Offer trade setups (only if the user wants them).** For a chosen pick, propose a concrete setup using the scanned levels:
   - Direction (LONG/SHORT) from `bias`.
   - Entry near current price (or a pullback level).
   - Stop-loss beyond the relevant S/R level (`support` for longs, `resistance` for shorts), sanity-checked against `atrPct`.
   - Take-profit at the opposite level or a sensible R-multiple.

5. **Order execution — confirm first, every time.** If the user wants to act:
   - Restate symbol, side, order type, qty, entry price, SL, TP, and leverage in one line.
   - Call `bybit_get_wallet_balance` / `bybit_get_positions` to sanity-check sizing and avoid conflicting positions.
   - Get an explicit "yes" from the user, THEN call `bybit_place_order` (qty/price as strings).
   - Never place, modify, or cancel orders without that explicit confirmation. See [[bybit-mcp-mainnet]].

## Output Template (chat summary)

```
Market scan ({timeframe}, {scanned} symbols) — {longs} long / {shorts} short
Report: output/scan_market/scan-<ts>.md

Top setups:
| Symbol | Bias | Score | Price | RSI | Funding% | Key signals |
|--------|------|-------|-------|-----|----------|-------------|
| ...    | LONG | 4.5   | ...   | 28  | -0.012   | RSI oversold; near support; neg funding |
```

## Notes & Guardrails

- **Read-only by default.** The scan never trades. Order placement happens only after an explicit user confirmation in the same turn.
- **Mainnet = real money.** Always confirm before any `bybit_place_order` / `bybit_set_leverage` call.
- Scores are a heuristic, not a recommendation — present them as signals, not certainties. Always include the "not financial advice" framing.
- If the script reports errors for some symbols (delisted, illiquid), mention them briefly but don't block the rest of the scan.
- Don't dump the full per-symbol JSON into chat — summarize the top picks and point to the report file.
- If credentials are missing or invalid, the script still returns public data (tickers/klines work without keys); private steps (balance/positions/orders) will fail with a clear error — tell the user to check `bybit-mcp/.env`.
