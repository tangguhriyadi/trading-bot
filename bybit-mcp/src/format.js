export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    isError,
  };
}

export function requireCredentials(hasCredentials) {
  if (!hasCredentials()) {
    return jsonResult({
      success: false,
      error: 'No Bybit API credentials configured.',
      hint: 'Create bybit-mcp/.env from .env.example with BYBIT_API_KEY and BYBIT_API_SECRET, then restart Claude Code.',
    }, true);
  }
  return null;
}
