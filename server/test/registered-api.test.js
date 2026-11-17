// Registered-client mode through the real API, against fakes on loopback only: a PingOne-like authorization server that knows one
// registered client (inline public key, no CIMD), a PingFederate-like one that does not, and a Company that records what it receives.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import express from 'express';
import { createApp } from '../src/app.js';
import { createSessions } from '../src/sessions.js';
import { createHealth } from '../src/health.js';
import { generateEs256Key, jwkThumbprint, decodeJws } from '../src/jose.js';
import { verifyEs256 } from './helpers.js';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const opened = [];
const listen = (app, port = 0) => new Promise((res) => { const s = http.createServer(app).listen(port, '127.0.0.1', () => { opened.push(s); res(s); }); });
const originOf = (s) => `http://127.0.0.1:${s.address().port}`;
after(() => { for (const s of opened) s.close(); });

const REGISTERED_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const k = generateEs256Key();
const agentKey = { privateKey: k.privateKey, publicJwk: k.publicJwk, kid: jwkThumbprint(k.publicJwk) };

// An authorization server. `registeredId` set = it only knows that client (PingOne-like, key registered inline); null = CIMD-like,
// it accepts any client_id and checks the assertion against the agent key. expect.aud/typ mirror what the real server wants.
async function makeAs({ prefix, registeredId, expect }) {
  const seen = { par: [], token: [], authorize: [], assertions: [], all: 0 };
  const as = { seen, expect: { ...expect } };
  const a = express();
  a.use((_q, _r, next) => { seen.all += 1; next(); });
  const server = await listen(a);
  const origin = originOf(server);
  as.issuer = `${origin}${prefix}`;
  const urls = { par: `${as.issuer}/par`, token: `${as.issuer}/token`, authorize: `${as.issuer}/authorize` };
  const meta = () => ({ issuer: as.issuer, authorization_endpoint: urls.authorize, token_endpoint: urls.token, pushed_authorization_request_endpoint: urls.par });
  a.get(`${prefix}/.well-known/oauth-authorization-server`, (_q, r) => r.json(meta()));
  const checkAssertion = (form, endpoint) => {
    const j = verifyEs256(form.client_assertion || 'x.y.z', agentKey.publicJwk);
    seen.assertions.push({ header: j.header, payload: j.payload });
    const want = as.expect.aud === 'endpoint' ? endpoint : as.issuer;
    if (!j.ok || j.header.typ !== as.expect.typ || j.payload.aud !== want || j.payload.iss !== form.client_id || j.payload.sub !== form.client_id) return false;
    if (registeredId && form.client_id !== registeredId) return false;
    return !('client_secret' in form);
  };
  const pushed = new Map();
  a.post(`${prefix}/par`, express.urlencoded({ extended: false }), (q, r) => {
    seen.par.push(q.body);
    if (!checkAssertion(q.body, urls.par)) return r.status(401).json({ error: 'invalid_client' });
    const uri = `urn:ietf:params:oauth:request_uri:${crypto.randomBytes(8).toString('hex')}`;
    pushed.set(uri, q.body);
    r.status(201).json({ request_uri: uri, expires_in: 60 });
  });
  a.get(`${prefix}/authorize`, (q, r) => {
    seen.authorize.push(q.query);
    const p = pushed.get(q.query.request_uri);
    if (!p || p.client_id !== q.query.client_id) return r.status(400).json({ error: 'invalid_request_uri' });
    as.lastPushed = p;
    r.redirect(`${p.redirect_uri}?code=CODE1&state=${encodeURIComponent(p.state)}&iss=${encodeURIComponent(as.issuer)}`);
  });
  a.post(`${prefix}/token`, express.urlencoded({ extended: false }), (q, r) => {
    seen.token.push(q.body);
    const pkce = crypto.createHash('sha256').update(q.body.code_verifier || '').digest('base64url') === as.lastPushed?.code_challenge;
    if (!checkAssertion(q.body, urls.token) || !pkce || q.body.code !== 'CODE1' || q.body.client_id !== as.lastPushed.client_id) return r.status(400).json({ error: 'invalid_client' });
    const claims = { iss: as.issuer, client_id: q.body.client_id, scope: as.lastPushed.scope, sub: 'person-1' };
    const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    r.json({ access_token: jwt, token_type: 'Bearer', expires_in: 60, scope: as.lastPushed.scope });
  });
  return as;
}

async function makeCompany(issuer) {
  const calls = [];
  const a = express();
  let server;
  a.get('/.well-known/poppy.json', (_q, r) => r.json({ protocol_version: '1.0', organization: { domain: new URL(originOf(server)).host }, auth: { issuer, scopes: { 'accounts:read': 'Read accounts' }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } } }));
  a.get('/.well-known/oauth-protected-resource', (_q, r) => r.json({ resource: originOf(server), authorization_servers: [issuer] }));
  a.get('/poppy/api/v1/me', (q, r) => { calls.push(q.headers); r.json({ ok: true }); });
  server = await listen(a);
  return { origin: originOf(server), calls };
}

async function startLab({ registered }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = createApp({ agent: agentKey, baseUrl, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: (...a) => fetch(...a), registered });
  await listen(app, port);
  const post = (path, body, ws = 'w1') => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: JSON.stringify(body ?? {}) });
  const get = (path, ws = 'w1') => fetch(`${baseUrl}${path}`, { headers: { 'x-workspace': ws }, redirect: 'manual' });
  // discover, authorize, and the browser's two hops back to /cb
  const signIn = async (co, as, ws = 'w1', extra = {}) => {
    const d = await post('/api/discover', { origin: co.origin, issuer: new URL(as.issuer).origin, ...extra }, ws);
    if (d.status !== 200) return { d };
    const a = await post('/api/authorize', { scope: 'accounts:read', ...extra }, ws);
    const aj = await a.json();
    if (!aj.url) return { d, a: aj };
    const toAs = await fetch(aj.url, { redirect: 'manual' });
    const cb = await fetch(toAs.headers.get('location'), { redirect: 'manual', headers: { 'x-workspace': ws } });
    return { d, a: aj, cb };
  };
  return { baseUrl, post, get, signIn };
}

const PINGONE_LIKE = { aud: 'endpoint', typ: 'JWT' };
const reg = (issuer, over = {}) => ({ clientId: REGISTERED_ID, issuer, assertionAud: 'endpoint', assertionTyp: 'JWT', ...over });

test('/api/info reports the registered client, and agentClientId stays the CIMD URL', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const on = await startLab({ registered: reg(as.issuer) });
  const i = await (await on.get('/api/info')).json();
  assert.deepEqual(i.registered, { available: true, issuer: as.issuer, clientId: REGISTERED_ID, problem: null });
  assert.equal(i.agentClientId, `${on.baseUrl}/client.json`);
  const off = await startLab({ registered: null });
  assert.deepEqual((await (await off.get('/api/info')).json()).registered, { available: false, issuer: null, clientId: null, problem: null });
});

test('registered sign-in: the registered id is the client_id on PAR, authorize and token, with no secret, then a call carries it as iss', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: reg(as.issuer) });
  const { d, a, cb } = await lab.signIn(co, as);
  assert.equal(d.status, 200);
  assert.equal(a.clientId, REGISTERED_ID);
  assert.equal(a.clientKind, 'registered');
  assert.equal(a.par, true);
  assert.equal(new URL(a.url).searchParams.get('client_id'), REGISTERED_ID);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /signin=ok/);

  assert.equal(as.seen.par.length, 1);
  const par = as.seen.par[0];
  assert.equal(par.client_id, REGISTERED_ID);
  assert.equal('client_secret' in par, false);
  assert.equal(par.redirect_uri, `${lab.baseUrl}/cb`);
  assert.equal(par.scope, 'accounts:read', 'no openid is added');
  assert.equal(par.code_challenge_method, 'S256');
  const [pa, ta] = as.seen.assertions;
  assert.deepEqual([pa.header.typ, pa.payload.iss, pa.payload.sub, pa.payload.aud], ['JWT', REGISTERED_ID, REGISTERED_ID, `${as.issuer}/par`]);
  assert.equal(as.seen.token.length, 1);
  assert.equal(as.seen.token[0].client_id, REGISTERED_ID);
  assert.equal('client_secret' in as.seen.token[0], false);
  assert.equal(ta.payload.aud, `${as.issuer}/token`);

  const st = await (await lab.get('/api/state')).json();
  assert.equal(st.signedIn, true);
  assert.equal(st.token.claims.client_id, REGISTERED_ID);

  const c = await (await lab.post('/api/call', { path: '/poppy/api/v1/me' })).json();
  assert.equal(c.response.status, 200);
  const h = co.calls.at(-1);
  const sess = decodeJws(h['poppy-session']);
  const dlg = decodeJws(sess.header.poppy_dlg);
  assert.equal(sess.payload.iss, REGISTERED_ID);
  assert.equal(dlg.payload.iss, REGISTERED_ID);
  assert.equal(sess.payload.aud, as.issuer, 'the Session audience is still the issuer the Company published');
  assert.ok(verifyEs256(sess.header.poppy_dlg, agentKey.publicJwk).ok);

  const everything = JSON.stringify([st, c, a, await (await lab.get('/api/info')).json()]);
  assert.ok(!everything.includes(`"d":"`) && !everything.includes(k.privateKey.export({ format: 'jwk' }).d), 'no private key material in any response');
});

test('PAT_P1_ASSERTION_AUD=issuer and a custom typ reach the assertions', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: { aud: 'issuer', typ: 'client-authentication+jwt' } });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: reg(as.issuer, { assertionAud: 'issuer', assertionTyp: 'client-authentication+jwt' }) });
  const { cb } = await lab.signIn(co, as);
  assert.match(cb.headers.get('location'), /signin=ok/);
  assert.deepEqual(as.seen.assertions.map((x) => x.payload.aud), [as.issuer, as.issuer]);
  // and a lab left on the defaults is refused by an issuer that wants the other shape: the knob is what changes the outcome
  const wrong = await startLab({ registered: reg(as.issuer) });
  const { a } = await wrong.signIn(co, as);
  assert.equal(a.error, 'par_failed');
});

test('a PingFederate issuer never gets the registered id, even when the request asks for it', async () => {
  const pingone = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const pf = await makeAs({ prefix: '', registeredId: null, expect: { aud: 'issuer', typ: 'client-authentication+jwt' } });
  const co = await makeCompany(pf.issuer);
  const lab = await startLab({ registered: reg(pingone.issuer) });
  const cimd = `${lab.baseUrl}/client.json`;
  const { a, cb } = await lab.signIn(co, pf, 'w1', { registered: true, client: 'registered', clientId: REGISTERED_ID });
  assert.equal(a.clientId, cimd);
  assert.equal(a.clientKind, 'cimd');
  assert.match(cb.headers.get('location'), /signin=ok/);
  assert.equal(pf.seen.par[0].client_id, cimd);
  assert.equal(pf.seen.token[0].client_id, cimd);
  assert.deepEqual(pf.seen.assertions.map((x) => [x.header.typ, x.payload.aud, x.payload.iss]), [['client-authentication+jwt', pf.issuer, cimd], ['client-authentication+jwt', pf.issuer, cimd]]);
  assert.ok(!JSON.stringify(pf.seen).includes(REGISTERED_ID), 'the registered id never reached the PingFederate-like server');
  const c = await (await lab.post('/api/call', { path: '/poppy/api/v1/me' })).json();
  assert.equal(c.response.status, 200);
  assert.equal(decodeJws(decodeJws(co.calls.at(-1)['poppy-session']).header.poppy_dlg).payload.iss, cimd);
  assert.equal(pingone.seen.all, 0, 'the PingOne-like server was never contacted');
});

test('the issuer is the PingOne one but no registered client id is configured: 409 registered_client_missing, nothing sent to the issuer', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: null });
  const before = process.env.PAT_DEMO_P1_ISSUER;
  process.env.PAT_DEMO_P1_ISSUER = as.issuer;
  try {
    const d = await lab.post('/api/discover', { origin: co.origin, issuer: new URL(as.issuer).origin });
    assert.equal(d.status, 409);
    const j = await d.json();
    assert.equal(j.error, 'registered_client_missing');
    assert.match(j.message, /PAT_P1_CLIENT_ID/);
    assert.equal(as.seen.all, 0);
    assert.equal((await (await lab.get('/api/state')).json()).config, null, 'nothing was stored for the workspace');
  } finally {
    if (before === undefined) delete process.env.PAT_DEMO_P1_ISSUER; else process.env.PAT_DEMO_P1_ISSUER = before;
  }
});

test('with PAT_DEMO_P1_ISSUER unset a plain PingFederate-style discovery is untouched (no 409)', async () => {
  const pf = await makeAs({ prefix: '', registeredId: null, expect: { aud: 'issuer', typ: 'client-authentication+jwt' } });
  const co = await makeCompany(pf.issuer);
  const lab = await startLab({ registered: null });
  const { d, a } = await lab.signIn(co, pf);
  assert.equal(d.status, 200);
  assert.equal(a.clientKind, 'cimd');
});

const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k2) => [k2, process.env[k2]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k2, v] of Object.entries(before)) { if (v === undefined) delete process.env[k2]; else process.env[k2] = v; } }
};

test('finding: a trailing slash on the configured issuer does not silently fall back to the CIMD client_id', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: reg(`${as.issuer}/`) }); // PAT_DEMO_P1_ISSUER ends with "/", the Company publishes it without
  const { a, cb } = await lab.signIn(co, as);
  assert.equal(a.clientKind, 'registered');
  assert.equal(a.clientId, REGISTERED_ID);
  assert.equal(as.seen.par[0].client_id, REGISTERED_ID);
  assert.match(cb.headers.get('location'), /signin=ok/);
});

test('finding: the missing-client guard also fires when the configured PingOne issuer differs only by a trailing slash', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: null });
  await withEnv({ PAT_DEMO_P1_ISSUER: `${as.issuer}/` }, async () => {
    const d = await lab.post('/api/discover', { origin: co.origin, issuer: new URL(as.issuer).origin });
    assert.equal(d.status, 409);
    assert.equal((await d.json()).error, 'registered_client_missing');
    assert.equal(as.seen.all, 0);
  });
});

test('finding: an invalid PAT_P1_ASSERTION_AUD is reported as that, not as a missing client id', async () => {
  const as = await makeAs({ prefix: '/ENV/as', registeredId: REGISTERED_ID, expect: PINGONE_LIKE });
  const co = await makeCompany(as.issuer);
  const lab = await startLab({ registered: null });
  await withEnv({ PAT_DEMO_P1_ISSUER: as.issuer, PAT_P1_CLIENT_ID: 'x', PAT_P1_ASSERTION_AUD: 'bogus' }, async () => {
    const info = await (await lab.get('/api/info')).json();
    assert.equal(info.registered.available, false);
    assert.match(info.registered.problem, /PAT_P1_ASSERTION_AUD must be/);
    const d = await lab.post('/api/discover', { origin: co.origin, issuer: new URL(as.issuer).origin });
    assert.equal(d.status, 409);
    const j = await d.json();
    assert.equal(j.error, 'registered_config_invalid');
    assert.match(j.message, /PAT_P1_ASSERTION_AUD must be/);
    assert.doesNotMatch(j.message, /needs a registered client_id|Set PAT_P1_CLIENT_ID/);
    assert.equal(as.seen.all, 0);
  });
});
