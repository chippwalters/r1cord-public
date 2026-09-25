const DEFAULT_ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isAllowedExternalUrl(url, options = {}) {
  if (!url || typeof url !== 'string') return false;
  const allowedProtocols = options.allowedProtocols || DEFAULT_ALLOWED_PROTOCOLS;
  const allowedHosts = options.allowedHosts;

  try {
    const parsed = new URL(url);
    if (!allowedProtocols.has(parsed.protocol)) return false;
    if (allowedHosts && parsed.hostname && !allowedHosts.includes(parsed.hostname)) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

async function openExternalSafely(shell, url, options = {}) {
  if (!isAllowedExternalUrl(url, options)) {
    throw new Error(`Blocked unsafe external URL: ${url || '<empty>'}`);
  }
  await shell.openExternal(url);
  return true;
}

module.exports = {
  DEFAULT_ALLOWED_PROTOCOLS,
  isAllowedExternalUrl,
  openExternalSafely,
};
