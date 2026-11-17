// Registered-client mode, unit level: env parsing, the one place the client_id is chosen, assertion shapes, and doctor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredFrom, registeredProblem, clientFor } from '../src/registered.js';
import { clientAssertion, parRequest, tokenRequest, ASSERTION_TYP } from '../src/oauth.js';
import { generateEs256Key, jwkThumbprint, decodeJws } from '../src/jose.js';
import { runChecks } from '../src/doctor.js';
import { verifyEs256 } from './helpers.js';

const ISS = 'https://auth.pingone.example/ENV/as';
const ID = '11111111-2222-3333-4444-555555555555';
const k = generateEs256Key();
const kid = jwkThumbprint(k.publicJwk);
const base = { PAT_P1_CLIENT_ID: ID, PAT_DEMO_P1_ISSUER: ISS };

test('registeredFrom needs both the client id and the issuer, and defaults aud to endpoint and typ to JWT', () => {
  assert.equal(registeredFrom({}), null);
  assert.equal(registeredFrom({ PAT_P1_CLIENT_ID: ID }), null);
  assert.equal(registeredFrom({ PAT_DEMO_P1_ISSUER: ISS }), null);
  assert.equal(registeredFrom({ PAT_P1_CLIENT_ID: '  ', PAT_DEMO_P1_ISSUER: ISS }), null);
  assert.deepEqual(registeredFrom(base), { clientId: ID, issuer: ISS, assertionAud: 'endpoint', assertionTyp: 'JWT' });
  assert.deepEqual(registeredFrom({ ...base, PAT_P1_ASSERTION_AUD: 'issuer', PAT_P1_ASSERTION_TYP: 'client-authentication+jwt' }),
    { clientId: ID, issuer: ISS, assertionAud: 'issuer', assertionTyp: 'client-authentication+jwt' });
});

test('an invalid PAT_P1_ASSERTION_AUD is a problem and turns registered mode off', () => {
  const env = { ...base, PAT_P1_ASSERTION_AUD: 'audience' };
  assert.match(registeredProblem(env), /PAT_P1_ASSERTION_AUD/);
  assert.equal(registeredFrom(env), null);
  assert.equal(registeredProblem(base), null);
  assert.equal(registeredProblem({}), null);
});

test('clientFor picks the registered id only for the registered issuer', () => {
  const registered = registeredFrom(base);
  assert.deepEqual(clientFor({ registered, baseUrl: 'http://127.0.0.1:5450', issuerClaim: ISS }), { id: ID, kind: 'registered' });
  assert.deepEqual(clientFor({ registered, baseUrl: 'http://127.0.0.1:5450', issuerClaim: 'https://pf.example:9031' }), { id: 'http://127.0.0.1:5450/client.json', kind: 'cimd' });
  assert.deepEqual(clientFor({ registered, baseUrl: 'http://127.0.0.1:5450', issuerClaim: `${ISS}/` }), { id: ID, kind: 'registered' }, 'a trailing slash is not a different issuer');
  assert.deepEqual(clientFor({ registered: registeredFrom({ ...base, PAT_DEMO_P1_ISSUER: `${ISS}//` }), baseUrl: 'http://127.0.0.1:5450', issuerClaim: ISS }), { id: ID, kind: 'registered' }, 'the configured side may carry the slash');
  assert.deepEqual(clientFor({ registered, baseUrl: 'http://127.0.0.1:5450', issuerClaim: `${ISS}/x` }), { id: 'http://127.0.0.1:5450/client.json', kind: 'cimd' }, 'any other difference still means another issuer');
  assert.deepEqual(clientFor({ registered, baseUrl: 'http://127.0.0.1:5450', issuerClaim: ISS.toUpperCase() }), { id: 'http://127.0.0.1:5450/client.json', kind: 'cimd' }, 'case is not folded');
  assert.deepEqual(clientFor({ registered: null, baseUrl: 'https://agent.example', issuerClaim: ISS }), { id: 'https://agent.example/client.json', kind: 'cimd' });
});

test('the CIMD assertion is unchanged: typ client-authentication+jwt, aud = issuer, iss = sub = client id', () => {
  const cimd = 'https://agent.example/client.json';
  const jws = clientAssertion({ clientId: cimd, issuer: 'https://pf.example:9031', kid, signingKey: k.privateKey, now: 1000 });
  const a = verifyEs256(jws, k.publicJwk);
  assert.ok(a.ok);
  assert.deepEqual(a.header, { typ: 'client-authentication+jwt', alg: 'ES256', kid });
  assert.equal(ASSERTION_TYP, 'client-authentication+jwt');
  const { jti, ...rest } = a.payload;
  assert.ok(jti);
  assert.deepEqual(rest, { iss: cimd, sub: cimd, aud: 'https://pf.example:9031', iat: 1000, exp: 1060 });
  // PAR and token requests with no assertion arguments carry exactly that.
  for (const r of [
    parRequest({ parEndpoint: 'https://pf.example:9031/par', clientId: cimd, issuer: 'https://pf.example:9031', kid, signingKey: k.privateKey, redirectUri: 'https://agent.example/cb', scope: 's', state: 'st', challenge: 'ch' }),
    tokenRequest({ tokenEndpoint: 'https://pf.example:9031/token', clientId: cimd, issuer: 'https://pf.example:9031', kid, signingKey: k.privateKey, code: 'c', redirectUri: 'https://agent.example/cb', verifier: 'v' }),
  ]) {
    const d = decodeJws(new URLSearchParams(r.body).get('client_assertion'));
    assert.equal(d.header.typ, 'client-authentication+jwt');
    assert.equal(d.payload.aud, 'https://pf.example:9031');
    assert.equal(new URLSearchParams(r.body).get('client_id'), cimd);
  }
});

test('a registered assertion: iss = sub = the registered id, aud and typ as configured, and no secret in the form', () => {
  const par = parRequest({ parEndpoint: `${ISS}/par`, clientId: ID, issuer: ISS, assertionAud: `${ISS}/par`, assertionTyp: 'JWT', kid, signingKey: k.privateKey, redirectUri: 'http://127.0.0.1:5450/cb', scope: 'accounts:read', state: 'st', challenge: 'ch' });
  const tok = tokenRequest({ tokenEndpoint: `${ISS}/token`, clientId: ID, issuer: ISS, assertionAud: ISS, assertionTyp: 'JWT', kid, signingKey: k.privateKey, code: 'c', redirectUri: 'http://127.0.0.1:5450/cb', verifier: 'v' });
  const pf = new URLSearchParams(par.body); const tf = new URLSearchParams(tok.body);
  assert.equal(pf.get('client_id'), ID); assert.equal(tf.get('client_id'), ID);
  assert.equal(pf.has('client_secret'), false); assert.equal(tf.has('client_secret'), false);
  const a = verifyEs256(pf.get('client_assertion'), k.publicJwk);
  assert.ok(a.ok);
  assert.equal(a.header.typ, 'JWT');
  assert.equal(a.payload.iss, ID); assert.equal(a.payload.sub, ID);
  assert.equal(a.payload.aud, `${ISS}/par`);
  assert.equal(decodeJws(tf.get('client_assertion')).payload.aud, ISS);
});

test('doctor: registered mode makes http loopback a pass, anything else http stays a fail, and p1-client reports the settings', async () => {
  const get = async (env, id) => (await runChecks({ env })).find((c) => c.id === id);
  const loop = { ...base, PAT_AGENT_BASE_URL: 'http://127.0.0.1:5450' };
  const a = await get(loop, 'agent-url');
  assert.equal(a.level, 'pass'); assert.match(a.detail, /registered client, http loopback/);
  assert.equal((await get({ ...base, PAT_AGENT_BASE_URL: 'http://localhost:5450' }, 'agent-url')).level, 'pass');
  assert.equal((await get({ PAT_AGENT_BASE_URL: 'http://127.0.0.1:5450' }, 'agent-url')).level, 'fail', 'no registered client: still https only');
  assert.equal((await get({ PAT_DEMO_P1_ISSUER: ISS, PAT_AGENT_BASE_URL: 'http://127.0.0.1:5450' }, 'agent-url')).level, 'fail', 'issuer without a client id is not fully configured');
  assert.equal((await get({ ...base, PAT_AGENT_BASE_URL: 'http://agent.example:5450' }, 'agent-url')).level, 'fail', 'a non-loopback http base is never allowed');
  assert.equal((await get({ ...base, PAT_AGENT_BASE_URL: 'http://127.0.0.1.example:5450' }, 'agent-url')).level, 'fail', 'a lookalike host is not loopback');
  assert.equal((await get({ ...base, PAT_AGENT_BASE_URL: 'https://agent.example' }, 'agent-url')).level, 'pass');
  assert.equal((await get({}, 'p1-client')).level, 'pass');
  assert.equal((await get({ PAT_DEMO_P1_ISSUER: ISS }, 'p1-client')).level, 'info');
  // a client id with no PingOne issuer is ignored, so it must not read as a pass
  const orphan = await get({ PAT_P1_CLIENT_ID: ID }, 'p1-client');
  assert.equal(orphan.level, 'info'); assert.match(orphan.detail, /PAT_P1_CLIENT_ID is set but PAT_DEMO_P1_ISSUER is not.*ignored/);
  // the http loopback pass is for PingOne only
  assert.match(a.detail, /PingFederate CIMD sign-in needs https/);
  assert.equal((await get(base, 'p1-client')).level, 'pass');
  const bad = await get({ ...base, PAT_P1_ASSERTION_AUD: 'nope' }, 'p1-client');
  assert.equal(bad.level, 'fail'); assert.match(bad.detail, /PAT_P1_ASSERTION_AUD/);
});
