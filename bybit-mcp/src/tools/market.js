import { z } from 'zod';
import { jsonResult } from '../format.js';
import { getClient, call } from '../client.js';

const categoryEnum = z.enum(['spot', 'linear', 'inverse', 'option']);
const intervalEnum = z.enum(['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M']);

export function registerMarketTools(server) {
  server.tool(
    'bybit_get_ticker',
    'Get real-time ticker for a symbol: last price, 24h high/low/change, volume, best bid/ask, funding rate. No API key required.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT, ETHUSDT'),
      category: categoryEnum.optional().describe('Market type (default: linear for USDT perpetuals; use spot for spot)'),
    },
    async ({ symbol, category }) => {
      try {
        const out = await call(getClient().getTickers({ category: category || 'linear', symbol }));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_kline',
    'Get OHLCV candlestick (kline) data for a symbol. No API key required.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT'),
      interval: intervalEnum.describe('Candle interval in minutes (1,3,5,15,30,60,120,240,360,720) or D/W/M'),
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      limit: z.coerce.number().min(1).max(1000).optional().describe('Number of candles (default 200, max 1000)'),
    },
    async ({ symbol, interval, category, limit }) => {
      try {
        const out = await call(getClient().getKline({
          category: category || 'linear',
          symbol,
          interval,
          limit: limit || 200,
        }));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_get_orderbook',
    'Get the current order book (bids/asks) for a symbol. No API key required.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT'),
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      limit: z.coerce.number().min(1).max(500).optional().describe('Depth per side (default 25)'),
    },
    async ({ symbol, category, limit }) => {
      try {
        const out = await call(getClient().getOrderbook({
          category: category || 'linear',
          symbol,
          limit: limit || 25,
        }));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
