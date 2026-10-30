// An independent check of what a Company must verify, written from the spec text rather than from the signer, so a
// signing mistake cannot hide behind a matching verifier mistake.
import crypto from 'node:crypto';

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
export const jwkFor = (jwk) => crypto.createPublicKey({ key: jwk, format: 'jwk' });

export function verifyEs256(token, jwk) {
  const [h, p, s] = token.split('.');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: jwkFor(jwk), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { ok, header: decode(h), payload: decode(p) };
}
