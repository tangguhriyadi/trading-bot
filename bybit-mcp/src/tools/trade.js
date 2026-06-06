import { z } from 'zod';
import { jsonResult, requireCredentials } from '../format.js';
import { getClient, call, hasCredentials } from '../client.js';

const categoryEnum = z.enum(['spot', 'linear', 'inverse', 'option']);

export function registerTradeTools(server) {
  server.tool(
    'bybit_place_order',
    'Place an order (Market or Limit). USES REAL FUNDS on mainnet. Confirm symbol, side, qty, and price with the user before calling.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT'),
      side: z.enum(['Buy', 'Sell']).describe('Order side'),
      orderType: z.enum(['Market', 'Limit']).describe('Order type'),
      qty: z.string().describe('Order quantity as a string, e.g. "0.01" (base coin for linear/spot)'),
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      price: z.string().optional().describe('Limit price (required for Limit orders)'),
      timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional().describe('Time in force (default GTC for Limit)'),
      reduceOnly: z.coerce.boolean().optional().describe('Reduce-only (close position, do not open new)'),
      takeProfit: z.string().optional().describe('Take-profit trigger price'),
      stopLoss: z.string().optional().describe('Stop-loss trigger price'),
      orderLinkId: z.string().optional().describe('Custom client order id for idempotency'),
    },
    async ({ symbol, side, orderType, qty, category, price, timeInForce, reduceOnly, takeProfit, stopLoss, orderLinkId }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { category: category || 'linear', symbol, side, orderType, qty };
        if (price) params.price = price;
        if (timeInForce) params.timeInForce = timeInForce;
        if (reduceOnly !== undefined) params.reduceOnly = reduceOnly;
        if (takeProfit) params.takeProfit = takeProfit;
        if (stopLoss) params.stopLoss = stopLoss;
        if (orderLinkId) params.orderLinkId = orderLinkId;
        const out = await call(getClient().submitOrder(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_cancel_order',
    'Cancel a single open order by orderId or orderLinkId. Requires API key.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT'),
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      orderId: z.string().optional().describe('Bybit order id'),
      orderLinkId: z.string().optional().describe('Custom client order id'),
    },
    async ({ symbol, category, orderId, orderLinkId }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      if (!orderId && !orderLinkId) {
        return jsonResult({ success: false, error: 'Provide either orderId or orderLinkId.' }, true);
      }
      try {
        const params = { category: category || 'linear', symbol };
        if (orderId) params.orderId = orderId;
        if (orderLinkId) params.orderLinkId = orderLinkId;
        const out = await call(getClient().cancelOrder(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_cancel_all_orders',
    'Cancel ALL open orders for a category (optionally filtered by symbol). Requires API key.',
    {
      category: categoryEnum.optional().describe('Market type (default: linear)'),
      symbol: z.string().optional().describe('Restrict to one symbol; omit to cancel all in the category'),
      settleCoin: z.string().optional().describe('Settle coin, e.g. USDT (used when no symbol given)'),
    },
    async ({ category, symbol, settleCoin }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const params = { category: category || 'linear' };
        if (symbol) params.symbol = symbol;
        else params.settleCoin = settleCoin || 'USDT';
        const out = await call(getClient().cancelAllOrders(params));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bybit_set_leverage',
    'Set leverage for a symbol (derivatives only). Requires API key.',
    {
      symbol: z.string().describe('Trading symbol, e.g. BTCUSDT'),
      buyLeverage: z.string().describe('Buy leverage as a string, e.g. "5"'),
      sellLeverage: z.string().describe('Sell leverage as a string, e.g. "5"'),
      category: categoryEnum.optional().describe('Market type (default: linear)'),
    },
    async ({ symbol, buyLeverage, sellLeverage, category }) => {
      const missing = requireCredentials(hasCredentials);
      if (missing) return missing;
      try {
        const out = await call(getClient().setLeverage({
          category: category || 'linear',
          symbol,
          buyLeverage,
          sellLeverage,
        }));
        return jsonResult(out, !out.success);
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
