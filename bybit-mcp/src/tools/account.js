import { z } from 'zod';
import { jsonResult, requireCredentials } from '../format.js';
import { getClient, call, hasCredentials, getConfig } from '../client.js';

const categoryEnum = z.enum(['spot', 'linear', 'inverse', 'option']);

export function registerAccountTools(server) {
  server.tool(
    'bybit_health_check',
    'Verify the Bybit API connection and credentials. Reports whether keys are configured, testnet vs mainnet, and server time.',
    {},
    async () => {
      try {
        const cfg = getConfig();
        const time = await call(getClient().getServerTime());
        const out = {
          success: time.success,
          credentials_configured: hasCredentials(),
          network: cfg.testnet ? 'testnet' : 'mainnet',
          server_time: time.result,
        };
        if (hasCredentials()) {
          // A private call confirms the key/secret actually work.
          const bal = await call(getClient().getWalletBalance({ accountType: 'UNIFIED' }));
          out.credentials_valid = bal.success;
          if (!bal.success) out.credentials_error = bal.error;
        }
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_wallet_balance',
    'Get wallet balance: total equity, available balance, and per-coin holdings. Requires API key.',
    {
      accountType: z.enum(['UNIFIED', 'CONTRACT', 'SPOT']).optional().describe('Account type (default UNIFIED)'),
      coin: z.string().optional().describe('Filter to a single coin, e.g. USDT'),
    },
    async ({ accountType, coin }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { accountType: accountType || 'UNIFIED' };
        if (coin) params.coin = coin;
        const out = await call(getClient().getWalletBalance(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_positions',
    'Get current open positions (size, entry price, leverage, unrealized P&L, liquidation price). Requires API key.',
    {
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      symbol: z.string().optional().describe('Filter to one symbol, e.g. BTCUSDT'),
      settleCoin: z.string().optional().describe('Settle coin, e.g. USDT (used when no symbol given)'),
    },
    async ({ category, symbol, settleCoin }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { category: category || 'linear' };
        if (symbol) params.symbol = symbol;
        else params.settleCoin = settleCoin || 'USDT';
        const out = await call(getClient().getPositionInfo(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_open_orders',
    'Get currently open (unfilled) orders. Requires API key.',
    {
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      symbol: z.string().optional().describe('Filter to one symbol'),
      settleCoin: z.string().optional().describe('Settle coin, e.g. USDT (used when no symbol given)'),
    },
    async ({ category, symbol, settleCoin }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { category: category || 'linear' };
        if (symbol) params.symbol = symbol;
        else params.settleCoin = settleCoin || 'USDT';
        const out = await call(getClient().getActiveOrders(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_order_history',
    'Get historical (filled/cancelled) orders. Requires API key.',
    {
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      symbol: z.string().optional().describe('Filter to one symbol'),
      limit: z.coerce.number().min(1).max(50).optional().describe('Number of records (default 20, max 50)'),
    },
    async ({ category, symbol, limit }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { category: category || 'linear', limit: limit || 20 };
        if (symbol) params.symbol = symbol;
        const out = await call(getClient().getHistoricOrders(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
