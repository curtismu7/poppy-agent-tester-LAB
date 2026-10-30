import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateEs256Key, jwkThumbprint, decodeJws } from '../src/jose.js';
import { signDelegation, signSession, DELEGATION_TYP, SESSION_TYP } from '../src/poppy.js';
import { verifyEs256 } from './helpers.js';

const CLIENT = 'https://agent.example/client.json';
const ISSUER = 'https://pf.example:9031';
const NOW = 1_800_000_000;

function setup() {
  const agent = generateEs256Key();
  const delegated = generateEs256Key();
  const delegation = signDelegation({ clientId: CLIENT, kid: 'a1', signingKey: agent.privateKey, delegatedPublicJwk: delegated.publicJwk, now: NOW });
  return { agent, delegated, delegation };
}

test('generated keys are P-256 and sign verifiably', () => {
  const k = generateEs256Key();
  assert.equal(k.publicJwk.crv, 'P-256');
  assert.equal(k.publicJwk.d, undefined);
  assert.ok(k.privateJwk.d);
});

test('delegation: typ, iss, 24h cap, delegated key in cnf, verifies against the agent key', () => {
  const { agent, delegated, delegation } = setup();
  const v = verifyEs256(delegation, agent.publicJwk);
  assert.ok(v.ok);
  assert.equal(v.header.typ, DELEGATION_TYP);
  assert.equal(v.header.kid, 'a1');
  assert.equal(v.payload.iss, CLIENT);
  assert.deepEqual(v.payload.cnf.jwk, delegated.publicJwk);
  assert.ok(v.payload.exp - v.payload.iat <= 24 * 3600);
  assert.throws(() => signDelegation({ clientId: CLIENT, kid: 'a1', signingKey: agent.privateKey, delegatedPublicJwk: delegated.publicJwk, lifetimeSeconds: 24 * 3600 + 1 }), RangeError);
  assert.throws(() => signDelegation({ clientId: CLIENT, kid: 'a1', signingKey: agent.privateKey, delegatedPublicJwk: delegated.publicJwk, lifetimeSeconds: 0 }), RangeError);
});

test('session: signed by the delegated key, kid is its thumbprint, claims bind method, url and token', () => {
  const { agent, delegated, delegation } = setup();
  const token = 'pf-access-token';
  const session = signSession({
    delegation, delegatedKey: delegated, clientId: CLIENT, issuer: ISSUER, sid: 'sid-1', sub: 'user-1',
    method: 'get', url: 'https://company.example/poppy/api/v1/me?x=1#frag', accessToken: token, now: NOW,
  });
  const v = verifyEs256(session, delegated.publicJwk);
  assert.ok(v.ok);
  assert.equal(v.header.typ, SESSION_TYP);
  assert.equal(v.header.kid, jwkThumbprint(delegated.publicJwk));
  assert.equal(v.header.pap_dlg, delegation);
  assert.equal(v.payload.iss, CLIENT);
  assert.equal(v.payload.aud, ISSUER);
  assert.equal(v.payload.htm, 'GET');
  assert.equal(v.payload.htu, 'https://company.example/poppy/api/v1/me');
  assert.equal(v.payload.ath, crypto.createHash('sha256').update(token).digest('base64url'));
  assert.ok(v.payload.jti);
  // the session must NOT verify against the agent's own key: the delegated key signs it
  assert.equal(verifyEs256(session, agent.publicJwk).ok, false);
  // and the delegation inside it verifies against the agent key
  assert.ok(verifyEs256(decodeJws(session).header.pap_dlg, agent.publicJwk).ok);
});

test('every session gets its own jti, and a tampered payload no longer verifies', () => {
  const { delegated, delegation } = setup();
  const args = { delegation, delegatedKey: delegated, clientId: CLIENT, issuer: ISSUER, sid: 's', sub: 'u', method: 'GET', url: 'https://c.example/x', now: NOW };
  const a = signSession(args);
  const b = signSession(args);
  assert.notEqual(decodeJws(a).payload.jti, decodeJws(b).payload.jti);
  const [h, , s] = a.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...decodeJws(a).payload, sub: 'someone-else' })).toString('base64url')}.${s}`;
  assert.equal(verifyEs256(forged, delegated.publicJwk).ok, false);
});

test('no ath when there is no access token yet', () => {
  const { delegated, delegation } = setup();
  const s = signSession({ delegation, delegatedKey: delegated, clientId: CLIENT, issuer: ISSUER, sid: 's', sub: 'u', method: 'GET', url: 'https://c.example/x' });
  assert.equal(decodeJws(s).payload.ath, undefined);
});

test('htu drops a fragment on its own and a query on its own', () => {
  const { delegated, delegation } = setup();
  const h = (url) => decodeJws(signSession({ delegation, delegatedKey: delegated, clientId: CLIENT, issuer: ISSUER, sid: 's', sub: 'u', method: 'GET', url, now: NOW })).payload.htu;
  assert.equal(h('https://c.example/x#f'), 'https://c.example/x');
  assert.equal(h('https://c.example/x?q=1'), 'https://c.example/x');
  assert.equal(h('https://c.example/x'), 'https://c.example/x');
});

test('every delegation has its own jti and typ', () => {
  const { agent, delegated } = setup();
  const mk = () => decodeJws(signDelegation({ clientId: CLIENT, kid: 'a1', signingKey: agent.privateKey, delegatedPublicJwk: delegated.publicJwk, now: NOW }));
  const a = mk(); const b = mk();
  assert.notEqual(a.payload.jti, b.payload.jti);
  assert.equal(a.header.typ, DELEGATION_TYP);
});
