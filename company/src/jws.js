// Compact JWS helpers. Only node:crypto. Algorithms are pinned by the callers: RS256 for the access token, ES256 for the
// delegation and the session. Nothing here picks an algorithm from a token header.
import crypto from 'node:crypto';

export const b64url = (input) => Buffer.from(input).toString('base64url');

const B64URL = /^[A-Za-z0-9_-]+$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An HTTP-shaped refusal. `description` never carries token text. `extra` is merged into the JSON body. */
export class CompanyError extends Error {
  constructor(status, code, description, extra = {}) {
    super(description);
    this.status = status;
    this.code = code;
    this.description = description;
    this.extra = extra;
  }
}

/** Splits and parses a compact JWS without verifying it. Returns null for anything that is not three base64url parts with JSON-object header and payload. */
export function decodeJws(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!isObject(header) || !isObject(payload)) return null;
    // RFC 7515 4.1.11: a recipient MUST reject a JWS that lists a critical extension it does not understand. This code understands none.
    if ('crit' in header) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch { return null; }
}

/** A public EC P-256 JWK: right type and curve, 32-byte coordinates, no private member. */
export function isPublicEcP256Jwk(jwk) {
  if (!isObject(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) return false;
  return ['x', 'y'].every((m) => typeof jwk[m] === 'string' && B64URL.test(jwk[m]) && Buffer.from(jwk[m], 'base64url').length === 32);
}

/** RFC 7638 SHA-256 thumbprint of an EC public JWK, base64url. */
export function jwkThumbprint(jwk) {
  return crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

/** ES256 (P-256, SHA-256, raw r||s signature). `decoded` comes from decodeJws. */
export function verifyEs256(decoded, jwk) {
  try {
    if (!decoded || decoded.signature.length !== 64 || !isPublicEcP256Jwk(jwk)) return false;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(decoded.signingInput), { key, dsaEncoding: 'ieee-p1363' }, decoded.signature);
  } catch { return false; }
}

/** A public RSA key of at least 2048 bits as a KeyObject, or null. */
function publicRsaKey(jwk) {
  if (!isObject(jwk) || jwk.kty !== 'RSA' || 'd' in jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  return key.asymmetricKeyDetails.modulusLength >= 2048 ? key : null;
}

/** RS256 (RSASSA-PKCS1-v1_5, SHA-256). Keys under 2048 bits are refused. */
export function verifyRs256(decoded, jwk) {
  try {
    const key = decoded && publicRsaKey(jwk);
    return key ? crypto.verify('sha256', Buffer.from(decoded.signingInput), key, decoded.signature) : false;
  } catch { return false; }
}

/** PS384 (RSASSA-PSS, SHA-384, MGF1 with SHA-384, salt length 48; RFC 7518 3.5). Keys under 2048 bits are refused. */
export function verifyPs384(decoded, jwk) {
  try {
    const key = decoded && publicRsaKey(jwk);
    if (!key) return false;
    return crypto.verify('sha384', Buffer.from(decoded.signingInput), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, decoded.signature);
  } catch { return false; }
}
