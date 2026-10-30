// Compact JWS helpers for ES256 only. Zero dependencies. P-256 keys are built from createECDH, never from generateKeyPair
// (generateKeyPair('ec') aborted on Node 20.20.2 in CI).
import crypto from 'node:crypto';

export const b64url = (input) => Buffer.from(input).toString('base64url');

/** A fresh P-256 key as { privateKey: KeyObject, publicJwk, privateJwk }. */
export function generateEs256Key() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); // 0x04 | X(32) | Y(32)
  const publicJwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  const privateJwk = { ...publicJwk, d: ecdh.getPrivateKey().toString('base64url') };
  return { privateKey: crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }), publicJwk, privateJwk };
}

/** RFC 7638 thumbprint of an EC public JWK. */
export function jwkThumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function signJws(header, payload, privateKey) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

/** Decode without verifying, for display. Returns null when the text is not a compact JWS. */
export function decodeJws(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()), payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()) };
  } catch { return null; }
}
