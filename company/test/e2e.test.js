// The ONE end-to-end test (design 7.1). Everything runs in this process on 127.0.0.1: the real lab (createApp, registered mode),
// the real reference Company (createCompanyApp) and the fake authorization server in fakeAs.js. No external host, no credentials.
// The lab's own fetch goes through a wrapper so a case can change what the lab sends to the Company (replay, missing header, swapped bearer).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/src/app.js';
import { createSessions } from '../../server/src/sessions.js';
import { createHealth } from '../../server/src/health.js';
import { loadAgentKey } from '../../server/src/agentKey.js';
import { decodeJws } from '../../server/src/jose.js';
import { createCompanyApp } from '../src/app.js';
import { startFakeAs } from './fakeAs.js';

const AUDIENCE = 'https://company.example/poppy';
const REGISTERED_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const ME = '/poppy/api/v1/me';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const servers = [];
const listen = (handler, port = 0) => new Promise((res) => { const s = http.createServer(handler).listen(port, '127.0.0.1', () => { servers.push(s); res(s); }); });

let tmp; let as; let agent; let lab; let labBase; let company; let companyB; let companyPort;
// What the lab sends to a Company, and what a case wants done to it. `mode` is set by a case and always reset.
const hooks = { mode: null, calls: [], lastBearers: [], swapBearer: null, replayed: null };

// The lab's fetch. Requests to a Company origin (the /poppy/ API) are recorded and, per `mode`, changed; everything else passes through.
async function labFetch(url, init = {}) {
  if (!String(url).includes('/poppy/api/')) return fetch(url, init);
  const headers = { ...init.headers };
  hooks.calls.push({ url: String(url), headers: { ...headers } });
  if (headers.authorization) hooks.lastBearers.push(headers.authorization);
  if (hooks.mode === 'no-version') delete headers['poppy-version'];
  if (hooks.mode === 'swap-bearer') headers.authorization = hooks.swapBearer;
  if (hooks.mode === 'replay') {
    hooks.replayed = await fetch(url, { ...init, headers });
    hooks.replayedBody = await hooks.replayed.clone().json();
  }
  return fetch(url, { ...init, headers });
}

const post = (p, body, ws) => fetch(`${labBase}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: JSON.stringify(body ?? {}) });
const get = (p, ws) => fetch(`${labBase}${p}`, { headers: { 'x-workspace': ws }, redirect: 'manual' });

/** discover, authorize, then the browser's two hops (authorize endpoint, then the lab's /cb). */
async function signIn(ws, companyOrigin = company.origin) {
  const d = await post('/api/discover', { origin: companyOrigin, issuer: as.issuer }, ws);
  const dj = await d.json();
  assert.equal(d.status, 200, `discover: ${JSON.stringify(dj).slice(0, 300)}`);
  // The lab's `issuer` check wants an https issuer (spec), and the fake AS is http on loopback, so `ok` is false for that one check only.
  // Every other check must pass; the lab still goes on to sign in, as it does against its own http fakes.
  const failed = dj.checks.filter((c) => !c.ok && c.level !== 'warn').map((c) => c.id);
  assert.deepEqual(failed, ['issuer']);
  const a = await post('/api/authorize', { scope: 'accounts:read' }, ws);
  const aj = await a.json();
  assert.equal(a.status, 200, `authorize: ${JSON.stringify(aj)}`);
  const toAs = await fetch(aj.url, { redirect: 'manual' });
  assert.equal(toAs.status, 302, 'the authorization server redirects straight back');
  const cb = await fetch(toAs.headers.get('location'), { redirect: 'manual', headers: { 'x-workspace': ws } });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /signin=ok/);
  return { aj, cb };
}

/** POST /api/call and return the Company's answer (status and parsed body) as the lab relays it. */
async function callMe(ws) {
  const r = await post('/api/call', { path: ME }, ws);
  assert.equal(r.status, 200, 'the lab itself answers; the Company status is inside');
  const j = await r.json();
  return { status: j.response.status, body: j.response.body, step: j };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-e2e-'));
  agent = loadAgentKey(tmp);
  const labPort = await freePort();
  labBase = `http://127.0.0.1:${labPort}`;
  companyPort = await freePort();
  const companyBPort = await freePort();

  as = await startFakeAs({ clients: [{ id: REGISTERED_ID, jwks: [{ ...agent.publicJwk, kid: agent.kid, alg: 'ES256', use: 'sig' }], redirectUri: `${labBase}/cb` }], audience: AUDIENCE });

  const cfg = (port, agentClientId) => ({
    origin: `http://127.0.0.1:${port}`, port, bind: '127.0.0.1', issuer: as.issuer, issuerJwksUri: `${as.origin}/jwks`, audience: AUDIENCE,
    agentClientId, agentJwksUri: `${labBase}/jwks.json`, allowLoopback: true, orgName: 'Reference Company', clockSkewSeconds: 5,
  });
  const a = await listen(createCompanyApp({ config: cfg(companyPort, REGISTERED_ID) }), companyPort);
  const b = await listen(createCompanyApp({ config: cfg(companyBPort, OTHER_ID) }), companyBPort);
  company = { origin: `http://127.0.0.1:${a.address().port}` };
  companyB = { origin: `http://127.0.0.1:${b.address().port}` };

  const registered = { clientId: REGISTERED_ID, issuer: as.issuer, assertionAud: 'endpoint', assertionTyp: 'JWT' };
  const app = createApp({ agent, baseUrl: labBase, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: labFetch, registered });
  lab = await listen(app, labPort);
});

after(async () => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await as?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('happy path: a registered-client sign-in ends in HTTP 200 signed_in from the Company', async () => {
  const ws = 'happy';
  const { aj } = await signIn(ws);
  assert.equal(aj.clientId, REGISTERED_ID);
  assert.equal(aj.clientKind, 'registered');
  assert.equal(aj.par, true);

  const c = await callMe(ws);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.state, 'signed_in');
  assert.ok(c.body.scopes.includes('accounts:read'));
  assert.equal(c.body.agent_id, REGISTERED_ID);

  // the user_id the Company returns is the Poppy-Session sub the lab sent, not the access token's sub
  const sent = hooks.calls.at(-1).headers;
  const session = decodeJws(sent['poppy-session']);
  assert.equal(c.body.user_id, session.payload.sub);
  assert.notEqual(c.body.user_id, as.knobs.userSub);
  assert.equal(c.body.session_id, session.payload.sid);
  assert.equal(sent['poppy-version'], '1.0');

  // what the authorization server saw
  const par = as.requestsTo('/par').at(-1);
  assert.equal(par.status, 201);
  assert.equal(par.body.client_id, REGISTERED_ID);
  assert.equal('client_secret' in par.body, false);
  assert.equal(par.body.redirect_uri, `${labBase}/cb`);
  assert.equal(par.body.scope, 'accounts:read');
  assert.deepEqual([par.assertion.header.alg, par.assertion.header.typ, par.assertion.header.kid], ['ES256', 'JWT', agent.kid]);
  assert.deepEqual([par.assertion.payload.iss, par.assertion.payload.sub, par.assertion.payload.aud], [REGISTERED_ID, REGISTERED_ID, `${as.origin}/par`]);
  const tok = as.requestsTo('/token').at(-1);
  assert.equal(tok.status, 200);
  assert.equal(tok.body.client_id, REGISTERED_ID);
  assert.equal('client_secret' in tok.body, false);
  assert.equal(tok.assertion.payload.aud, `${as.origin}/token`);
  assert.ok(!JSON.stringify(as.requests).includes(`"d":"`), 'no private key material reached the authorization server');
  // and the Company's documents are the ones the lab read
  const poppy = await (await fetch(`${company.origin}/.well-known/poppy.json`)).json();
  assert.equal(poppy.auth.issuer, as.issuer);
});

async function withKnob(name, value, fn) {
  const before = as.knobs[name];
  as.knobs[name] = value;
  try { return await fn(); } finally { as.knobs[name] = before; }
}

test('wrong audience on the access token: 401 invalid_token', async () => {
  await withKnob('tokenAudience', 'https://other.example', async () => {
    await signIn('wrong-aud');
    const c = await callMe('wrong-aud');
    assert.equal(c.status, 401);
    assert.equal(c.body.error, 'invalid_token');
    assert.match(c.body.error_description, /audience/);
  });
});

test('expired access token: 401 invalid_token', async () => {
  await withKnob('tokenExpOffsetSeconds', -30, async () => {
    await signIn('expired');
    const c = await callMe('expired');
    assert.equal(c.status, 401);
    assert.equal(c.body.error, 'invalid_token');
    assert.match(c.body.error_description, /expired/);
  });
});

test('replayed Poppy-Session: the first copy is 200, the identical second copy is 400 invalid_session', async () => {
  await signIn('replay');
  hooks.mode = 'replay';
  try {
    const c = await callMe('replay');
    assert.equal(hooks.replayed.status, 200, 'first copy');
    assert.equal(hooks.replayedBody.state, 'signed_in');
    assert.equal(c.status, 400, 'second, identical copy');
    assert.equal(c.body.error, 'invalid_session');
    assert.match(c.body.error_description, /jti was already used/);
  } finally { hooks.mode = null; hooks.replayed = null; }
});

test('a Poppy-Session paired with a different access token: 400 invalid_session (ath binds the Session to the token)', async () => {
  // Two real, valid tokens for the same client. The Session of the first carries ath of the first token only.
  await signIn('ath-a');
  await callMe('ath-a');
  const tokenA = hooks.lastBearers.at(-1);
  await signIn('ath-b');
  hooks.mode = 'swap-bearer';
  hooks.swapBearer = tokenA;
  try {
    const c = await callMe('ath-b');
    assert.notEqual(hooks.calls.at(-1).headers.authorization, tokenA, 'the lab sent its own token; the wrapper swapped it');
    assert.equal(c.status, 400);
    assert.equal(c.body.error, 'invalid_session');
    assert.match(c.body.error_description, /ath/);
  } finally { hooks.mode = null; hooks.swapBearer = null; }
});

test('unregistered client: a Company that registered another agent id answers 400 invalid_session', async () => {
  await signIn('unregistered', companyB.origin);
  const c = await callMe('unregistered');
  assert.equal(c.status, 400);
  assert.equal(c.body.error, 'invalid_session');
  assert.match(c.body.error_description, /not registered/);
});

test('missing Poppy-Version: 400 version_unsupported', async () => {
  await signIn('no-version');
  hooks.mode = 'no-version';
  try {
    const c = await callMe('no-version');
    assert.equal(c.status, 400);
    assert.equal(c.body.error, 'version_unsupported');
  } finally { hooks.mode = null; }
});
