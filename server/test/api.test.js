import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import express from 'express';
import { createApp } from '../src/app.js';
import { createSessions } from '../src/sessions.js';
import { generateEs256Key, jwkThumbprint, decodeJws } from '../src/jose.js';
import { createHealth } from '../src/health.js';
import { verifyEs256 } from './helpers.js';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const listen = (app) => new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
const originOf = (s) => `http://127.0.0.1:${s.address().port}`;

let agentPort; let appServer; let pf; let company; let app; let agentKey; let seen;

before(async () => {
  agentPort = await freePort();
  const base = `http://127.0.0.1:${agentPort}`;
  const k = generateEs256Key();
  agentKey = { privateKey: k.privateKey, publicJwk: k.publicJwk, kid: jwkThumbprint(k.publicJwk) };
  seen = { tokenForms: [], calls: [] };

  // A fake PingFederate: metadata, an authorize that redirects straight back, a token endpoint that checks the client assertion and PKCE.
  const pfApp = express();
  pfApp.get('/.well-known/openid-configuration', (_q, r) => r.json({ authorization_endpoint: `${originOf(pf)}/as/authorization.oauth2`, token_endpoint: `${originOf(pf)}/as/token.oauth2` }));
  pfApp.get('/as/authorization.oauth2', (q, r) => { seen.authorize = q.query; r.redirect(`${q.query.redirect_uri}?code=CODE1&state=${encodeURIComponent(q.query.state)}`); });
  pfApp.post('/as/token.oauth2', express.urlencoded({ extended: false }), (q, r) => {
    seen.tokenForms.push(q.body);
    const a = verifyEs256(q.body.client_assertion, agentKey.publicJwk);
    const challengeOk = crypto.createHash('sha256').update(q.body.code_verifier).digest('base64url') === seen.authorize.code_challenge;
    if (!a.ok || a.header.typ !== 'client-authentication+jwt' || a.payload.aud !== originOf(pf) || !challengeOk || q.body.code !== 'CODE1') return r.status(400).json({ error: 'invalid_client' });
    const claims = { client_id: seen.authorize.client_id, sub: 'person-1', scope: seen.authorize.scope };
    r.json({ access_token: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`, token_type: 'Bearer', expires_in: 60, scope: seen.authorize.scope });
  });
  pf = await listen(pfApp);

  // A fake Company: poppy.json, protected resource, and an API that records what it received.
  const coApp = express();
  coApp.get('/.well-known/poppy.json', (_q, r) => r.json({ protocol_version: '0.3', auth: { issuer: originOf(pf), scopes: { 'accounts:read': 'Read accounts' }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } } }));
  coApp.get('/.well-known/oauth-protected-resource', (_q, r) => r.json({ resource: originOf(company), authorization_servers: [originOf(pf)] }));
  coApp.get('/poppy/api/v1/me', (q, r) => { seen.calls.push(q.headers); r.json({ user_id: 'person-1' }); });
  company = await listen(coApp);

  app = createApp({ agent: agentKey, baseUrl: base, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: (...a) => fetch(...a) });
  appServer = await new Promise((res) => { const s = http.createServer(app).listen(agentPort, '127.0.0.1', () => res(s)); });
});
after(() => { for (const s of [appServer, pf, company]) s.close(); });

const post = (path, body, ws = 'w1') => fetch(`http://127.0.0.1:${agentPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: JSON.stringify(body ?? {}) });
const get = (path, ws = 'w1') => fetch(`http://127.0.0.1:${agentPort}${path}`, { headers: { 'x-workspace': ws }, redirect: 'manual' });

test('the agent publishes client metadata and a JWKS with no private part', async () => {
  const m = await (await get('/client.json')).json();
  assert.equal(m.client_id, `http://127.0.0.1:${agentPort}/client.json`);
  assert.equal(m.token_endpoint_auth_method, 'private_key_jwt');
  const j = await (await get('/jwks.json')).json();
  assert.equal(j.keys[0].kid, agentKey.kid);
  assert.equal(j.keys[0].d, undefined);
});

test('full run: discover, authorize, redirect back, token, signed call', async () => {
  const d = await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) });
  assert.equal(d.status, 200);
  const dj = await d.json();
  assert.ok(dj.checks.find((c) => c.id === 'resource').ok);

  const a = await (await post('/api/authorize', { scope: 'accounts:read' })).json();
  assert.equal(new URL(a.url).searchParams.get('client_id'), `http://127.0.0.1:${agentPort}/client.json`);
  assert.equal(new URL(a.url).searchParams.get('code_challenge_method'), 'S256');

  // the "browser" follows the authorization URL, then the redirect it gets back
  const toPf = await fetch(a.url, { redirect: 'manual' });
  const back = toPf.headers.get('location');
  const cb = await fetch(back, { redirect: 'manual', headers: { 'x-workspace': 'w1' } });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /signin=ok/);

  const st = await (await get('/api/state')).json();
  assert.equal(st.signedIn, true);
  assert.equal(st.token.claims.client_id, `http://127.0.0.1:${agentPort}/client.json`);
  assert.ok(!JSON.stringify(st).includes('"d"'), 'no private key material in state');

  const c = await post('/api/call', { path: '/poppy/api/v1/me' });
  assert.equal(c.status, 200);
  const cj = await c.json();
  assert.equal(cj.response.status, 200);
  const h = seen.calls.at(-1);
  assert.match(h.authorization, /^Bearer /);
  const sess = decodeJws(h['poppy-session']);
  assert.equal(sess.payload.htu, `${originOf(company)}/poppy/api/v1/me`);
  assert.equal(sess.payload.ath, crypto.createHash('sha256').update(h.authorization.slice(7)).digest('base64url'));
  assert.ok(verifyEs256(h['poppy-session'], sess.header.pap_dlg && decodeJws(sess.header.pap_dlg).payload.cnf.jwk).ok);
  assert.ok(verifyEs256(sess.header.pap_dlg, agentKey.publicJwk).ok);
  assert.match(h.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('two workspaces do not see each other, and Reset clears only its own', async () => {
  const other = await (await get('/api/state', 'w2')).json();
  assert.equal(other.signedIn, false);
  assert.equal(other.config, null);
  await post('/api/reset', {}, 'w1');
  assert.equal((await (await get('/api/state', 'w1')).json()).signedIn, false);
});

test('the issuer you type must match the one the Company publishes', async () => {
  const d = await post('/api/discover', { origin: originOf(company), issuer: 'http://127.0.0.1:9' }, 'w3');
  assert.equal(d.status, 400);
  assert.equal((await d.json()).error, 'issuer_mismatch');
});

test('a call before sign-in, a bad path, a bad scope and a bad workspace are refused', async () => {
  assert.equal((await post('/api/call', {}, 'w4')).status, 409);
  await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'w4');
  assert.equal((await post('/api/authorize', { scope: 'a"b' }, 'w4')).status, 400);
  assert.equal((await post('/api/call', { path: '//evil.example/x' }, 'w4')).status, 409); // not signed in yet
  assert.equal((await post('/api/call', { path: '/a/../b' }, 'w4')).status, 409);
  assert.equal((await get('/api/state', 'BAD WS')).status, 400);
});

test('a callback with an unknown state does nothing', async () => {
  const r = await get('/cb?code=x&state=nope');
  assert.equal(r.status, 400);
});

test('a non-loopback Host header is refused, and a cross-origin write is refused', async () => {
  const status = await new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: agentPort, path: '/api/info', headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }); q.on('error', rej); q.end(); });
  assert.equal(status, 403);
  const cross = await fetch(`http://127.0.0.1:${agentPort}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-workspace': 'w1' }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('the hosted build refuses every live endpoint', async () => {
  const hosted = createApp({ agent: null, hosted: true, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const s = await listen(hosted);
  const r = await fetch(`${originOf(s)}/api/discover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'https://x.example', issuer: 'https://y.example' }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'hosted_simulation');
  const sample = await (await fetch(`${originOf(s)}/api/sample`)).json();
  assert.equal(sample.example, true);
  assert.equal(sample.steps.length, 4);
  s.close();
});

test('/api/health is demo-health/1 with runtime live', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.schema, 'demo-health/1');
  assert.equal(h.runtime, 'live');
  assert.equal(h.demo.id, 'poppy-agent-tester');
});
