// JWKS fetching for the two operator-configured key sources (the AS and the agent). Never a URL taken from a request.
// Rules (design 4.6): https, or http on loopback when allowLoopback; no redirects; 5 s timeout; 64 KiB cap enforced while reading;
// the document must be {keys:[...]}; any `d` member anywhere makes the whole document invalid.
import { urlProblem } from './config.js';
import { isPublicEcP256Jwk } from './jws.js';

export const MAX_JWKS_BYTES = 64 * 1024;

/** A fetch or document problem. The message is safe to show: it never contains the response body. */
export class KeyFetchError extends Error {}

async function readCapped(res, limit) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new KeyFetchError('JWKS document is too large');
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new KeyFetchError('JWKS document is too large');
    return buf.toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new KeyFetchError('JWKS document is too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * kind 'agent': the agent's published keys. EC P-256 entries (ES256) and RSA entries (PS384, spec 5.2) are used; every other key type,
 *   curve or malformed entry is ignored, so one extra key never invalidates the others.
 * kind 'RSA': RSA entries are used, other key types are ignored (an AS may publish several types).
 * Entries without a string kid are ignored: there is no kid-less fallback. A repeated kid makes the document invalid.
 */
export function parseJwks(text, kind) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new KeyFetchError('JWKS document is not JSON'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.keys)) throw new KeyFetchError('JWKS document has no keys array');
  if (doc.keys.some((k) => k && typeof k === 'object' && 'd' in k)) throw new KeyFetchError('JWKS document contains private key material');
  const keys = new Map();
  for (const k of doc.keys) {
    if (!k || typeof k !== 'object' || Array.isArray(k)) throw new KeyFetchError('JWKS document has a malformed key');
    if (kind === 'agent') {
      if (k.use !== undefined && k.use !== 'sig') continue;
      if (isPublicEcP256Jwk(k)) { if (k.alg !== undefined && k.alg !== 'ES256') continue; }
      else if (k.kty === 'RSA' && typeof k.n === 'string' && typeof k.e === 'string') { if (k.alg !== undefined && k.alg !== 'PS384') continue; }
      else continue;
    } else {
      if (k.kty !== 'RSA') continue;
      if (typeof k.n !== 'string' || typeof k.e !== 'string') continue;
      if (k.use !== undefined && k.use !== 'sig') continue;
      if (k.alg !== undefined && k.alg !== 'RS256') continue;
    }
    if (typeof k.kid !== 'string' || k.kid === '') continue;
    if (keys.has(k.kid)) throw new KeyFetchError('JWKS document repeats a key id');
    keys.set(k.kid, k);
  }
  return keys;
}

/**
 * A cached key source. getKey(kid) resolves to a JWK or null (unknown kid) and rejects with KeyFetchError when the source cannot be read.
 * A cache younger than ttlMs is used. An unknown kid forces one refetch, at most once per refetchMinMs.
 */
export function createKeyStore({ uri, kind, fetchImpl = fetch, allowLoopback = false, now = () => Date.now(), ttlMs = 300_000, refetchMinMs = 30_000, timeoutMs = 5000, label = 'keys' }) {
  const problem = urlProblem(uri, allowLoopback);
  if (problem) throw new Error(`${label} URL ${problem}`);
  let cache = null; // { keys, fetchedAt }
  let lastAttemptAt = -Infinity;
  let inflight = null;

  async function download() {
    let res;
    try {
      res = await fetchImpl(uri, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch { throw new KeyFetchError(`${label} could not be fetched`); }
    if (res.status >= 300 && res.status < 400) throw new KeyFetchError(`${label} fetch was redirected, which is refused`);
    if (res.status !== 200) throw new KeyFetchError(`${label} fetch returned HTTP ${res.status}`);
    let text;
    try { text = await readCapped(res, MAX_JWKS_BYTES); } catch (e) { throw e instanceof KeyFetchError ? e : new KeyFetchError(`${label} could not be read`); }
    return parseJwks(text, kind);
  }

  function refresh() {
    if (!inflight) {
      lastAttemptAt = now();
      inflight = download().then((keys) => { cache = { keys, fetchedAt: now() }; }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    async getKey(kid) {
      if (typeof kid !== 'string' || kid === '') return null;
      const fresh = cache && now() - cache.fetchedAt < ttlMs;
      if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
      if (!fresh) await refresh();
      else if (now() - lastAttemptAt >= refetchMinMs) await refresh();
      return cache.keys.get(kid) ?? null;
    },
  };
}
