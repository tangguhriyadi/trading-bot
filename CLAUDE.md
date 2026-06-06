# AI Agent Trader

A Claude Code workspace for crypto trading on **Bybit** plus chart analysis on **TradingView**. Two MCP servers expose live data + execution; five skills orchestrate scanning, risk policy, order placement, and position management.

## ⚠️ Safety — read first

- **Bybit runs on MAINNET — real funds.** `bybit-mcp/.env` has `BYBIT_TESTNET=false`.
- **Never place, modify, or cancel an order without explicit user confirmation in the same turn.** Restate symbol/side/qty/price/SL/TP/leverage in one line and get a clear "yes" first.
- Trade-mutating skill scripts are **dry-run by default**; they execute only with `--confirm`.
- `place_trade` is gated by `risk_rules.json` — it refuses trades that breach the policy.
- Keys live in `bybit-mcp/.env` (gitignored). Never paste keys into chat or commit them.

## MCP Servers

| Server | Purpose | Entry | Config |
|---|---|---|---|
| `bybit` | Bybit v5: market data, account, trading | `bybit-mcp/src/server.js` | `bybit-mcp/.env` (key/secret, `BYBIT_TESTNET`) |
| `tradingview` | Read/control live TradingView Desktop via CDP (port 9222) | `tradingview-mcp/src/server.js` | needs TradingView running with `--remote-debugging-port=9222` |

Both are registered per-project in `~/.claude.json` (added via `claude mcp add`). Tools appear as `mcp__bybit__*` / `mcp__tradingview__*`. After editing a server, restart Claude Code to reload its tools. Quick health checks without restart: `node bybit-mcp/src/check.js` and `node tradingview-mcp/src/cli/index.js status`.

## Skills

**Location convention:** skill *source* lives in `skills/<name>/`; each is symlinked into `.claude/skills/<name>` so Claude Code auto-detects it. When creating a new skill, write it under `skills/` then run `ln -s ../../skills/<name> .claude/skills/<name>`. Do **not** delete the `skills/` folder.

| Skill | Does | Invoke |
|---|---|---|
| `scan_market` | Scan Bybit USDT perps, score setups (momentum, RSI/MACD/EMA, funding, S/R), write report to `output/scan_market/` | `/scan_market [symbols] [--tf 60]` |
| `risk_management` | Policy layer: audit account risk, pre-trade check, view/edit `risk_rules.json` | `/risk_management [--action audit\|check\|rules]` |
| `place_trade` | Risk-based order with SL/TP/leverage bracket; **gated by `risk_rules.json`** | `/place_trade SYMBOL Buy --entry P` |
| `manage_position` | View positions + PnL, close (full/partial), adjust SL/TP, breakeven, trailing | `/manage_position [--action view\|close\|sltp\|breakeven\|trail]` |
| `skill-builder` | Create/audit skills following best practices | `/skill-builder` |

Each trading skill is a thin SKILL.md (workflow + guardrails) over a Node engine (`<name>.js`) that reuses `bybit-mcp/src/client.js` for credentials. Engines print JSON; Claude summarizes and handles confirmation.

## Risk Policy — `risk_rules.json`

Single source of truth at the project root. `null` = rule off; percentages are of equity. **For live values, read `risk_rules.json` or run `risk_management --action rules` — never hardcode them in docs.**

Rules: `maxRiskPerTradePct`, `maxLeverage`, `maxConcurrentPositions`, `maxTotalOpenRiskPct`, `dailyLossLimitPct`.
- `place_trade` enforces `maxRiskPerTradePct` and `maxLeverage` as a hard gate at order time.
- `risk_management` (`audit`/`check`) enforces the rest (position count, total open risk, daily loss limit).

Edit via `risk_management --action rules --set key=value`. Changing a limit changes what `place_trade` allows — confirm before editing.

## Trading Workflow

```
/scan_market      → find setups (read-only)
/risk_management  → audit account / set limits  ──┐ policy
/place_trade      → open position ── auto-checked against risk_rules.json ◄┘
/manage_position  → monitor, breakeven, trail, partial/full close
```

## Automation — `agent.js`

`agent.js` (project root) is a fully-automated, non-interactive orchestrator for one trade cycle: audit → scan → pick → dry-run → live order. It runs the skill engines as subprocesses, parses their JSON, and logs to `logs/agent-YYYY-MM-DD.log`.

- `node agent.js` — **LIVE**: places a real order on mainnet.
- `node agent.js --dry-run` — full pipeline, places **NO** order (safe test).
- Logic: skips NEUTRAL/already-open symbols, respects `maxConcurrentPositions`, falls through past candidates blocked at dry-run, trades the highest-conviction one that passes. Exits without trading on risk BREACH / daily-loss / no valid candidate. Never throws — errors are logged and exit gracefully.
- Scheduled via cron every 2h. Cron must use the absolute nvm node path; on macOS grant `/usr/sbin/cron` Full Disk Access (project is under ~/Documents).

## Dev Notes

- Node ≥ 20.12 (uses `process.loadEnvFile`, `import.meta.dirname`). Run any engine directly from the project root, e.g. `node "skills/scan_market/scan.js" BTCUSDT`.
- Defaults baked into `place_trade`: risk 1%/trade, SL 5% from entry, TP 2R, 5x, Limit, category `linear` (one-way). Keep these ≤ the `risk_rules.json` caps or default trades get gated.
- `category` defaults to `linear` (USDT perps) everywhere; pass `spot` for spot. qty/price/leverage are strings (Bybit requirement).
