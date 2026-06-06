import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMarketTools } from './tools/market.js';
import { registerAccountTools } from './tools/account.js';
import { registerTradeTools } from './tools/trade.js';
import { getConfig } from './client.js';

const server = new McpServer(
  {
    name: 'bybit',
    version: '1.0.0',
    description: 'Bybit v5 API — market data, account info, and trading',
  },
  {
    instructions: `Bybit MCP — read market data, check your account, and place/cancel orders on Bybit v5.

TOOLS:
Market data (no API key needed):
- bybit_get_ticker → last price, 24h stats, bid/ask, funding rate
- bybit_get_kline → OHLCV candles (pass interval + limit)
- bybit_get_orderbook → live bids/asks

Account (API key required):
- bybit_health_check → verify connection + whether keys work + testnet/mainnet
- bybit_get_wallet_balance → equity, available balance, per-coin holdings
- bybit_get_positions → open positions, entry, leverage, uPnL, liq price
- bybit_get_open_orders → unfilled orders
- bybit_get_order_history → filled/cancelled orders

Trading (API key with Trade permission required):
- bybit_place_order → Market/Limit orders, optional TP/SL, reduceOnly
- bybit_cancel_order → cancel one order by id
- bybit_cancel_all_orders → cancel all (optionally per symbol)
- bybit_set_leverage → set leverage for a derivatives symbol

IMPORTANT SAFETY RULES:
- Default 'category' is 'linear' (USDT perpetuals). Use 'spot' for spot trading.
- ALWAYS confirm symbol, side, qty, and price with the user before calling bybit_place_order,
  bybit_cancel_all_orders, or bybit_set_leverage — these move real money on mainnet.
- qty/price/leverage are passed as STRINGS (Bybit requirement).
- Check bybit_health_check first if a private call fails — it reports testnet vs mainnet.`,
  }
);

registerMarketTools(server);
registerAccountTools(server);
registerTradeTools(server);

const cfg = getConfig();
process.stderr.write(`bybit-mcp  |  network=${cfg.testnet ? 'TESTNET' : 'MAINNET'}  keys=${cfg.key ? 'set' : 'missing'}\n`);
process.stderr.write('Unofficial tool. Not affiliated with Bybit or Anthropic. Trading involves financial risk.\n');

const transport = new StdioServerTransport();
await server.connect(transport);
