const localEndpoint = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]{0,62}\.local$/i.test(url.hostname) ||
      !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password ||
      url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Secure Mac address required');
  return url.origin;
};

// The complete code is an out-of-band credential. Never log it or publish it via /info.
// It retains the existing 256-bit secret, certificate pin and two-minute server expiry.
export function createConnectionCode({endpoint, pin, secret, expiresAt}, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(pin) || !/^[a-f0-9]{64}$/.test(secret) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 120000) {
    throw new Error('A current secure pairing offer is required');
  }
  const value = {v: 1, endpoint: localEndpoint(endpoint), pin, secret, expiresAt};
  return 'FLYX1-' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
