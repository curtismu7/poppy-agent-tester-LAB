import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessTokenVerifier } from '../src/token.js';
import { createKeyStore } from '../src/keys.js';
import { CompanyError } from '../src/jws.js';
import { buildWorld, genRsa, signRs256, b64u, tamper, json, routedFetch, ISSUER, AUDIENCE, AGENT_ID } from './helpers.js';

function setup(over = {}) {
  const w = buildWorld(over);
  const keyStore = createKeyStore({ uri: w.config.issuerJwksUri, kind: 'RSA', fetchImpl: w.fetchImpl, allowLoopback: true, now: w.clk.now });
  w.verify = createAccessTokenVerifier({ config: w.config, keyStore, now: w.clk.now });
  return w;
}
const refused = (p, status, code, re) => assert.rejects(p, (e) => e instanceof CompanyError && e.status === status && e.code === code && (!re || re.test(e.description)), `${status} ${code} ${re ?? ''}`);
const invalid = (p, re) => refused(p, 401, 'invalid_token', re);

test('a valid token verifies and returns claims, scopes and client id', async () => {
  const w = setup();
  const r = await w.verify(w.token());
  assert.equal(r.clientId, AGENT_ID);
  assert.deepEqual(r.scopes, ['accounts:read']);
  assert.equal(r.claims.iss, ISSUER);
});

test('aud may be a string or an array containing the audience; scope may carry other scopes', async () => {
  const w = setup();
  await w.verify(w.token({ aud: AUDIENCE }));
  await w.verify(w.token({ aud: ['https://other.example', AUDIENCE] }));
  const r = await w.verify(w.token({ scope: 'openid accounts:read profile' }));
  assert.deepEqual(r.scopes, ['openid', 'accounts:read', 'profile']);
});

test('not a JWT at all', async () => {
  const w = setup();
  for (const t of ['', 'abc', 'a.b', 'a.b.c', '{"alg":"RS256"}']) await invalid(w.verify(t), /not a signed JWT/);
});

test('algorithm pinning: only RS256 is accepted, whatever the label says', async () => {
  const w = setup();
  for (const alg of ['none', 'HS256', 'ES256', 'RS384', 'PS256', 'rs256', undefined]) {
    await invalid(w.verify(w.token({}, { header: { alg } })), /must be RS256/);
  }
  // An HMAC "signature" made with the public modulus as the secret (the classic confusion) is refused.
  const secret = Buffer.from(w.as.publicJwk.n, 'base64url');
  const input = `${b64u({ alg: 'HS256', kid: w.as.kid })}.${b64u({ iss: ISSUER, aud: [AUDIENCE], client_id: AGENT_ID, scope: 'accounts:read', exp: w.clk.sec() + 60 })}`;
  await invalid(w.verify(`${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`), /must be RS256/);
});

test('alg none with an empty signature is refused', async () => {
  const w = setup();
  const t = `${b64u({ alg: 'none', kid: w.as.kid })}.${b64u({ iss: ISSUER, aud: AUDIENCE, client_id: AGENT_ID, scope: 'accounts:read', exp: w.clk.sec() + 60 })}.`;
  await invalid(w.verify(t));
});

test('kid: missing, non-string, unknown (no kid-less fallback)', async () => {
  const w = setup();
  await invalid(w.verify(w.token({}, { header: { kid: undefined } })), /no key id/);
  await invalid(w.verify(w.token({}, { header: { kid: 7 } })), /no key id/);
  await invalid(w.verify(w.token({}, { header: { kid: 'other' } })), /key id is not a signing key/);
});

test('an unknown kid forces a refetch (once per 30 s) so a rotated AS key is picked up', async () => {
  const w = setup();
  await w.verify(w.token());
  const rotated = genRsa('as-key-2');
  w.docs.as.keys.push(rotated.publicJwk);
  const t2 = w.token({}, { header: { kid: 'as-key-2' }, key: rotated.privateKey });
  await invalid(w.verify(t2), /key id is not a signing key/); // refetch is rate limited right after the first load
  w.clk.advance(31);
  assert.equal((await w.verify(t2)).clientId, AGENT_ID);
  assert.equal(w.fetchImpl.count(w.config.issuerJwksUri), 2);
});

test('signature: wrong key under a known kid, and a tampered payload', async () => {
  const w = setup();
  await invalid(w.verify(w.token({}, { key: genRsa('x').privateKey })), /signature/);
  await invalid(w.verify(tamper(w.token(), 1, (p) => ({ ...p, scope: 'accounts:read admin' }))), /signature/);
});

test('an RSA key under 2048 bits is refused even when the AS publishes it', async () => {
  const w = setup();
  const weak = genRsa('as-key-1', 1024);
  w.docs.as.keys = [weak.publicJwk];
  await invalid(w.verify(w.token({}, { key: weak.privateKey })), /signature/);
});

test('the signature is checked before the claims (a forged expired token says signature)', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ exp: 1 }, { key: genRsa('x').privateKey })), /signature/);
});

test('iss must equal the configured issuer', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ iss: 'https://evil.example/as' })), /issuer/);
  await invalid(w.verify(w.token({ iss: `${ISSUER}/` })), /issuer/);
  await invalid(w.verify(w.token({ iss: undefined })), /issuer/);
});

test('exp: required, numeric, and not older than the 5 s skew', async () => {
  const w = setup();
  const t = w.clk.sec();
  await w.verify(w.token({ exp: t - 4 }));
  await invalid(w.verify(w.token({ exp: t - 6 })), /expired/);
  await invalid(w.verify(w.token({ exp: undefined })), /expired/);
  await invalid(w.verify(w.token({ exp: String(t + 100) })), /expired/);
  await invalid(w.verify(w.token({ exp: null })), /expired/);
});

test('nbf: optional, must be numeric and not more than 5 s in the future', async () => {
  const w = setup();
  const t = w.clk.sec();
  await w.verify(w.token({ nbf: t + 4 }));
  await w.verify(w.token({ nbf: t - 100 }));
  await invalid(w.verify(w.token({ nbf: t + 6 })), /not valid yet/);
  await invalid(w.verify(w.token({ nbf: 'soon' })), /not valid yet/);
});

test('aud: wrong string, array without it, missing', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ aud: 'https://other.example' })), /audience/);
  await invalid(w.verify(w.token({ aud: ['https://other.example'] })), /audience/);
  await invalid(w.verify(w.token({ aud: [] })), /audience/);
  await invalid(w.verify(w.token({ aud: undefined })), /audience/);
  await invalid(w.verify(w.token({ aud: { 0: AUDIENCE } })), /audience/);
});

test('cnf of any kind (DPoP, mTLS) is refused', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ cnf: { jkt: 'abc' } })), /sender-constrained/);
  await invalid(w.verify(w.token({ cnf: { 'x5t#S256': 'abc' } })), /sender-constrained/);
  await invalid(w.verify(w.token({ cnf: {} })), /sender-constrained/);
  await invalid(w.verify(w.token({ cnf: null })), /sender-constrained/);
});

test('client_id: required string; azp is not accepted instead', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ client_id: undefined })), /client_id/);
  await invalid(w.verify(w.token({ client_id: undefined, azp: AGENT_ID })), /client_id/);
  await invalid(w.verify(w.token({ client_id: 12 })), /client_id/);
  await invalid(w.verify(w.token({ client_id: '' })), /client_id/);
});

test('scope: missing, other, substring-only and non-string are 403 insufficient_scope with scope in the body', async () => {
  const w = setup();
  for (const scope of [undefined, '', 'openid', 'accounts:readx', 'xaccounts:read', 'accounts:write', ['accounts:read'], 7]) {
    await assert.rejects(w.verify(w.token({ scope })), (e) => e instanceof CompanyError && e.status === 403 && e.code === 'insufficient_scope' && e.extra.scope === 'accounts:read', String(scope));
  }
});

test('order: cnf before client_id before scope; expiry before audience', async () => {
  const w = setup();
  await invalid(w.verify(w.token({ cnf: {}, client_id: undefined, scope: 'x' })), /sender-constrained/);
  await invalid(w.verify(w.token({ client_id: undefined, scope: 'x' })), /client_id/);
  await invalid(w.verify(w.token({ exp: 1, aud: 'x' })), /expired/);
});

test('AS keys that cannot be fetched are 503, not a verdict on the token', async () => {
  const w = buildWorld();
  const fetchImpl = routedFetch({ [w.config.issuerJwksUri]: () => json({ boom: true }, 500) });
  const keyStore = createKeyStore({ uri: w.config.issuerJwksUri, kind: 'RSA', fetchImpl, now: w.clk.now, allowLoopback: true });
  const verify = createAccessTokenVerifier({ config: w.config, keyStore, now: w.clk.now });
  await refused(verify(w.token()), 503, 'temporarily_unavailable', /could not be fetched/);
});

test('descriptions never contain token text', async () => {
  const w = setup();
  const bad = w.token({ aud: 'https://other.example' });
  await assert.rejects(w.verify(bad), (e) => !e.description.includes(bad) && !e.description.includes(bad.split('.')[1]) && !e.description.includes(AGENT_ID));
});
