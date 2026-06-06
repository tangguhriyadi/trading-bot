import { join } from 'node:path';
import { RestClientV5 } from 'bybit-api';

// Load .env sitting next to the package root (src/../.env), if present.
// Existing process env vars take precedence and are never overwritten.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'));
} catch {
  // No .env file — rely on whatever is already in process.env.
}

export function getConfig() {
  const testnet = String(process.env.BYBIT_TESTNET ?? 'true').toLowerCase() !== 'false';
  return {
    key: process.env.BYBIT_API_KEY || '',
    secret: process.env.BYBIT_API_SECRET || '',
    testnet,
  };
}

export function hasCredentials() {
  const { key, secret } = getConfig();
  return Boolean(key && secret);
}

let _client = null;

export function getClient() {
  if (_client) return _client;
  const cfg = getConfig();
  _client = new RestClientV5({
    key: cfg.key,
    secret: cfg.secret,
    testnet: cfg.testnet,
  });
  return _client;
}

// Run a Bybit v5 call and normalize the envelope.
// Bybit returns { retCode, retMsg, result, ... }; retCode 0 means success.
export async function call(promise) {
  const res = await promise;
  if (res.retCode !== 0) {
    return { success: false, retCode: res.retCode, error: res.retMsg, result: res.result };
  }
  return { success: true, result: res.result };
}
