// Quick CLI health check (run before restarting Claude Code):
//   node src/check.js
import { getClient, call, hasCredentials, getConfig } from './client.js';

const cfg = getConfig();
console.log(`network: ${cfg.testnet ? 'testnet' : 'mainnet'}`);
console.log(`keys configured: ${hasCredentials()}`);

const time = await call(getClient().getServerTime());
console.log('server time:', JSON.stringify(time));

if (hasCredentials()) {
  try {
    const bal = await call(getClient().getWalletBalance({ accountType: 'UNIFIED' }));
    console.log('credentials valid:', bal.success);
    if (!bal.success) console.log('error:', bal.error);
    else console.log('wallet:', JSON.stringify(bal.result));
  } catch (err) {
    // Never print the raw error object — it contains key/secret. Only the message.
    console.log('credentials valid: false');
    console.log('error:', err?.message || String(err));
  }
}
