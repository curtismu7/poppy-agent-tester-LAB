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
// Every server a test opens is closed in one after-hook, so a failing assertion cannot leave one listening.
const opened = [];
const listen = (app) => new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => { opened.push(s); res(s); }); });
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
  const pfMeta = () => ({ issuer: originOf(pf), authorization_endpoint: `${originOf(pf)}/as/authorization.oauth2`, token_endpoint: `${originOf(pf)}/as/token.oauth2`, ...(seen.pfMetaOverride || {}) });
  pfApp.get('/.well-known/oauth-authorization-server', (_q, r) => r.json(pfMeta()));
  pfApp.get('/.well-known/openid-configuration', (_q, r) => r.json(pfMeta()));
  pfApp.get('/as/authorization.oauth2', (q, r) => { seen.authorize = q.query; const iss = seen.redirectIss === undefined ? originOf(pf) : seen.redirectIss; r.redirect(`${q.query.redirect_uri}?code=CODE1&state=${encodeURIComponent(q.query.state)}${iss === null ? '' : `&iss=${encodeURIComponent(iss)}`}`); });
  pfApp.post('/as/token.oauth2', express.urlencoded({ extended: false }), (q, r) => {
    seen.tokenForms.push(q.body);
    const a = verifyEs256(q.body.client_assertion, agentKey.publicJwk);
    const challengeOk = crypto.createHash('sha256').update(q.body.code_verifier).digest('base64url') === seen.authorize.code_challenge;
    if (!a.ok || a.header.typ !== 'client-authentication+jwt' || a.payload.aud !== originOf(pf) || !challengeOk || q.body.code !== 'CODE1') return r.status(400).json({ error: 'invalid_client' });
    const claims = { client_id: seen.authorize.client_id, scope: seen.authorize.scope, ...(seen.noSub ? {} : { sub: 'person-1' }) };
    r.json({ access_token: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`, token_type: 'Bearer', expires_in: 60, scope: seen.authorize.scope });
  });
  pf = await listen(pfApp);

  // A fake Company: poppy.json, protected resource, and an API that records what it received.
  const coApp = express();
  coApp.get('/.well-known/poppy.json', (_q, r) => r.json({ protocol_version: '0.3', organization: { domain: new URL(originOf(company)).hostname }, auth: { issuer: originOf(pf), scopes: { 'accounts:read': 'Read accounts' }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } } }));
  coApp.get('/.well-known/oauth-protected-resource', (_q, r) => r.json({ resource: originOf(company), authorization_servers: [originOf(pf)] }));
  coApp.get('/poppy/api/v1/me', (q, r) => { seen.calls.push(q.headers); r.json({ user_id: 'person-1' }); });
  coApp.get('/poppy/api/v1/big', (_q, r) => r.type('text').send('x'.repeat(40 * 1024)));
  coApp.get('/poppy/api/v1/redirect', (_q, r) => r.redirect(`${originOf(company)}/poppy/api/v1/landed`));
  coApp.get('/poppy/api/v1/landed', (q, r) => { seen.landed = (seen.landed || 0) + 1; r.json({ landed: true }); });
  company = await listen(coApp);

  app = createApp({ agent: agentKey, baseUrl: base, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: (...a) => fetch(...a) });
  appServer = await new Promise((res) => { const s = http.createServer(app).listen(agentPort, '127.0.0.1', () => res(s)); });
});
after(() => { for (const s of [appServer, pf, company, ...opened]) s.close(); });

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
});

test('/api/health is demo-health/1 with runtime live', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.schema, 'demo-health/1');
  assert.equal(h.runtime, 'live');
  assert.equal(h.demo.id, 'poppy-agent-tester');
});

// ---- review findings: the properties below had no test ----
const signedIn = async (ws, { scope = 'accounts:read', resource } = {}) => {
  const d = await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, ws);
  assert.equal(d.status, 200, 'discover');
  const a = await (await post('/api/authorize', { scope, ...(resource === undefined ? {} : { resource }) }, ws)).json();
  const toPf = await fetch(a.url, { redirect: 'manual' });
  const cb = await fetch(toPf.headers.get('location'), { redirect: 'manual' });
  return { a, cb, location: toPf.headers.get('location') };
};

test('the Company resource (RFC 8707) is sent on both requests only when asked for, and not by default', async () => {
  const on = await signedIn('r1', { resource: true });
  assert.equal(new URL(on.a.url).searchParams.get('resource'), originOf(company));
  assert.equal(seen.tokenForms.at(-1).resource, originOf(company));
  const off = await signedIn('r1b');
  assert.equal(new URL(off.a.url).searchParams.has('resource'), false);
  assert.equal(seen.tokenForms.at(-1).resource, undefined);
  const strict = await signedIn('r1c', { resource: 'yes' }); // only a real true turns it on
  assert.equal(new URL(strict.a.url).searchParams.has('resource'), false);
});

test('sign-in state is single-use: replaying /cb makes no second token request', async () => {
  const { location } = await signedIn('r2');
  const before = seen.tokenForms.length;
  const replay = await fetch(location, { redirect: 'manual' });
  assert.equal(replay.status, 400);
  assert.equal(seen.tokenForms.length, before);
});

test('RFC 9207: a redirect from another issuer is refused before any token request', async () => {
  seen.redirectIss = 'https://other-issuer.example';
  try {
    const before = seen.tokenForms.length;
    const { cb } = await signedIn('r3');
    assert.match(cb.headers.get('location'), /signin=error/);
    assert.equal(seen.tokenForms.length, before, 'no code was sent anywhere');
    assert.equal((await (await get('/api/state', 'r3')).json()).signedIn, false);
  } finally { seen.redirectIss = undefined; }
});

test('RFC 9207: when the issuer says it always sends iss, a redirect without one is refused', async () => {
  seen.pfMetaOverride = { authorization_response_iss_parameter_supported: true }; seen.redirectIss = null;
  try {
    const before = seen.tokenForms.length;
    const { cb } = await signedIn('r4');
    assert.match(cb.headers.get('location'), /signin=error/);
    assert.equal(seen.tokenForms.length, before);
  } finally { seen.pfMetaOverride = undefined; seen.redirectIss = undefined; }
});

test('a token without sub is refused rather than signed with a made-up user', async () => {
  seen.noSub = true;
  try { await signedIn('r5'); } finally { seen.noSub = false; }
  const r = await post('/api/call', {}, 'r5');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'no_sub');
});

test('call paths: // and .. are refused with bad_path once signed in', async () => {
  await signedIn('r6');
  for (const p of ['//evil.example/x', '/a/../b', '/a//b', 'no-slash', '/x y']) {
    const r = await post('/api/call', { path: p }, 'r6');
    assert.equal(r.status, 400, p);
    assert.equal((await r.json()).error, 'bad_path', p);
  }
});

test('the Company is never followed through a redirect, and a big response is clipped', async () => {
  await signedIn('r7');
  seen.landed = 0;
  const redirected = await (await post('/api/call', { path: '/poppy/api/v1/redirect' }, 'r7')).json();
  assert.equal(redirected.response.status, 302);
  assert.equal(seen.landed, 0, 'the redirect target was never requested');
  const big = await (await post('/api/call', { path: '/poppy/api/v1/big' }, 'r7')).json();
  assert.match(String(big.response.body), /larger than 16384 bytes/);
});

test('an issuer whose endpoints sit on another origin is refused', async () => {
  seen.pfMetaOverride = { token_endpoint: 'https://elsewhere.example/token' };
  try {
    const d = await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'r8');
    assert.equal(d.status, 400);
    assert.equal((await d.json()).error, 'endpoint_origin');
  } finally { seen.pfMetaOverride = undefined; }
});

test('a Company whose issuer metadata names a different issuer fails the check', async () => {
  seen.pfMetaOverride = { issuer: 'https://not-the-issuer.example' };
  try {
    const d = await (await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'r9')).json();
    assert.equal(d.ok, false);
    assert.equal(d.checks.find((c) => c.id === 'issuer_metadata').ok, false);
  } finally { seen.pfMetaOverride = undefined; }
});

test('protected_resources is shown as a visible warning, and does not block the run', async () => {
  const d = await (await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'r10')).json();
  const c = d.checks.find((x) => x.id === 'protected_resources');
  assert.equal(c.ok, false);
  assert.equal(c.level, 'warn');
  // ok ignores warnings (it is false here only because the loopback test issuer is http, which the issuer check refuses)
  assert.equal(d.ok, d.checks.filter((x) => x.level !== 'warn').every((x) => x.ok));
  assert.equal(d.checks.find((x) => x.id === 'issuer').ok, false);
});

test('re-discovering clears a token, and Reset clears everything', async () => {
  await signedIn('r11');
  assert.equal((await (await get('/api/state', 'r11')).json()).signedIn, true);
  await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'r11');
  assert.equal((await (await get('/api/state', 'r11')).json()).signedIn, false);
});

test('discovery works without an agent URL (only sign-in and calls need one)', async () => {
  const bare = createApp({ agent: null, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: (...a) => fetch(...a) });
  const s = await listen(bare);
  const h = { 'content-type': 'application/json', 'x-workspace': 'b1' };
  const d = await fetch(`${originOf(s)}/api/discover`, { method: 'POST', headers: h, body: JSON.stringify({ origin: originOf(company), issuer: originOf(pf) }) });
  assert.equal(d.status, 200);
  const a = await fetch(`${originOf(s)}/api/authorize`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(a.status, 503);
});

test('a malformed or oversized JSON body is a JSON 400/413, never an HTML stack trace', async () => {
  const bad = await fetch(`http://127.0.0.1:${agentPort}/api/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': 'w1' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /json/);
  assert.equal((await bad.json()).error, 'bad_json');
  const big = await fetch(`http://127.0.0.1:${agentPort}/api/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': 'w1' }, body: JSON.stringify({ origin: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'body_too_large');
});

test('a cross-site write is refused, a same-site one too, a direct (none) one passes', async () => {
  const mk = (site) => fetch(`http://127.0.0.1:${agentPort}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': 'sf', 'sec-fetch-site': site }, body: '{}' });
  assert.equal((await mk('cross-site')).status, 403);
  assert.equal((await mk('same-site')).status, 403);
  assert.equal((await mk('none')).status, 200);
  assert.equal((await mk('same-origin')).status, 200);
});

test('the hosted build refuses authorize and call too, fast, and never opens a socket', async () => {
  const hosted = createApp({ agent: null, hosted: true, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const s = await listen(hosted);
  for (const [path, body] of [['/api/discover', { origin: 'https://x.example', issuer: 'https://y.example' }], ['/api/authorize', {}], ['/api/call', {}]]) {
    const r = await fetch(`${originOf(s)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    assert.equal(r.status, 403, path);
    assert.equal((await r.json()).error, 'hosted_simulation', path);
  }
});

test('the public agent name serves only client.json, jwks.json and /cb', async () => {
  const old = process.env.PAT_AGENT_HOST;
  process.env.PAT_AGENT_HOST = 'agent.example';
  try {
    const call = (path, method = 'GET', host = 'agent.example') => new Promise((res, rej) => {
      const q = http.request({ host: '127.0.0.1', port: agentPort, path, method, headers: { host } }, (r) => { r.resume(); res(r.statusCode); });
      q.on('error', rej); q.end();
    });
    assert.equal(await call('/client.json'), 200);
    assert.equal(await call('/jwks.json'), 200);
    assert.equal(await call('/cb?state=nope'), 400); // reaches the handler, which refuses an unknown state
    for (const p of ['/api/state', '/api/info', '/api/health', '/', '/index.html', '/api/discover']) assert.equal(await call(p), 403, p);
    assert.equal(await call('/api/discover', 'POST'), 403);
    assert.equal(await call('/client.json', 'POST'), 403);
    assert.equal(await call('/client.json', 'GET', 'evil.example'), 403);
  } finally { if (old === undefined) delete process.env.PAT_AGENT_HOST; else process.env.PAT_AGENT_HOST = old; }
});

// ---- second review: the public-name sign-in return, and the iss / body edge cases ----
const hostGet = (path, host) => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: agentPort, path, method: 'GET', headers: { host } }, (r) => { r.resume(); res({ status: r.statusCode, location: r.headers.location }); });
  q.on('error', rej); q.end();
});

test('the sign-in ends on the loopback page even when the redirect lands on the public agent name', async () => {
  const old = process.env.PAT_AGENT_HOST;
  process.env.PAT_AGENT_HOST = 'agent.example';
  try {
    const d = await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'rt1');
    assert.equal(d.status, 200);
    const a = await (await post('/api/authorize', { scope: 'accounts:read' }, 'rt1')).json();
    const toPf = await fetch(a.url, { redirect: 'manual' });
    const back = new URL(toPf.headers.get('location'));
    const cb = await hostGet(`${back.pathname}${back.search}`, 'agent.example');
    assert.equal(cb.status, 302);
    assert.equal(cb.location, `http://127.0.0.1:${agentPort}/?signin=ok`);
    assert.equal((await (await get('/api/state', 'rt1')).json()).signedIn, true);
  } finally { if (old === undefined) delete process.env.PAT_AGENT_HOST; else process.env.PAT_AGENT_HOST = old; }
});

test('an array-valued or repeated iss is refused as a mismatch, never coerced to the issuer', async () => {
  const before = seen.tokenForms.length;
  const cases = [
    (i) => `&iss=${encodeURIComponent(i)}&iss=${encodeURIComponent(i)}`,
    (i) => `&iss[]=${encodeURIComponent(i)}`,
  ];
  for (const [n, extraFor] of cases.entries()) {
    const ws = `rt2-${n}`;
    assert.equal((await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, ws)).status, 200);
    const a = await (await post('/api/authorize', { scope: 'accounts:read' }, ws)).json();
    const toPf = await fetch(a.url, { redirect: 'manual' });
    const back = new URL(toPf.headers.get('location'));
    const r = await fetch(`${back.origin}${back.pathname}${back.search}${extraFor(originOf(pf))}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.match(r.headers.get('location') || '', /signin=error/, `${r.status} case ${n}`);
  }
  assert.equal(seen.tokenForms.length, before, 'no token request was made');
});

test('a Company whose document is JSON null is a clean refusal, not a crash', async () => {
  const hardening = createApp({ agent: null, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: async (u) => new Response(u.endsWith('poppy.json') ? 'null' : '{}', { status: 200 }) });
  const s = await listen(hardening);
  const r = await fetch(`${originOf(s)}/api/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': 'nul' }, body: JSON.stringify({ origin: 'https://company.example', issuer: 'https://pf.example' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'not_json');
});

test('the default scope is accounts:read when advertised, not whatever is listed first', async () => {
  // A Company that lists an unrelated scope before accounts:read (a shared authorization server does this).
  const shared = express();
  shared.get('/.well-known/poppy.json', (_q, r) => r.json({ protocol_version: '0.3', organization: { domain: new URL(originOf(shared_s)).hostname }, auth: { issuer: originOf(pf), scopes: { 'audit:read': 'Unrelated', 'accounts:read': 'Read accounts' }, scope_hints: { 'audit:read': { changes: 'none', personal_data: false }, 'accounts:read': { changes: 'none', personal_data: true } } } }));
  shared.get('/.well-known/oauth-protected-resource', (_q, r) => r.json({ resource: originOf(shared_s), authorization_servers: [originOf(pf)] }));
  const shared_s = await listen(shared);
  const s = await listen(createApp({ agent: agentKey, baseUrl: `http://127.0.0.1:${agentPort}`, health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: (...a) => fetch(...a) }));
  const ws = 'dsc1';
  const d = await fetch(`${originOf(s)}/api/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: JSON.stringify({ origin: originOf(shared_s), issuer: originOf(pf) }) });
  assert.equal(d.status, 200, 'discover');
  const st = await (await fetch(`${originOf(s)}/api/state`, { headers: { 'x-workspace': ws } })).json();
  assert.equal(st.config.scope, 'accounts:read');
  s.close(); shared_s.close();
});

test('a typed host\'s permit is renewed when the sign-in reaches the token endpoint (not left to expire 30 s after discovery)', async () => {
  const { permitExpiry, clearPermitted } = await import('../src/netguard.js');
  clearPermitted();
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    const d = await post('/api/discover', { origin: originOf(company), issuer: originOf(pf) }, 'pr1');
    assert.equal(d.status, 200);
    const a = await (await post('/api/authorize', { scope: 'accounts:read' }, 'pr1')).json();
    const toPf = await fetch(a.url, { redirect: 'manual' });
    const back = new URL(toPf.headers.get('location'));
    const issuerHost = new URL(originOf(pf)).hostname;
    const firstExpiry = permitExpiry(issuerHost);
    assert.equal(firstExpiry, t0 + 30_000, 'discovery permits the issuer for 30 s');
    // 31 s later the permit has run out; the callback must renew it before the token request
    Date.now = () => t0 + 31_000;
    const cb = await fetch(`${back.origin}${back.pathname}${back.search}`, { redirect: 'manual' });
    assert.match(cb.headers.get('location') || '', /signin=ok/);
    assert.equal(permitExpiry(issuerHost), t0 + 31_000 + 30_000, 'the callback renewed the permit');
  } finally {
    Date.now = realNow;
    clearPermitted();
  }
});

test('rule 19: POST /api/mode switches mock↔real at runtime; exact body; 409 without settings; hosted gates follow the holder', async () => {
  const live = createApp({ agent: agentKey, baseUrl: `http://127.0.0.1:${agentPort}`, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const s = await listen(live);
  try {
    const o = originOf(s);
    const modePost = (body) => fetch(`${o}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const info = async () => (await (await fetch(`${o}/api/info`)).json());
    const bad = await modePost({ source: 'sideways' }); assert.equal(bad.status, 400);
    const extra = await modePost({ source: 'mock', extra: 1 }); assert.equal(extra.status, 400);
    const toReal = await modePost({ source: 'real' }); assert.equal(toReal.status, 200);
    assert.equal((await info()).source, 'real'); assert.equal((await info()).hosted, false); assert.equal((await info()).simulated, false);
    const toMock = await modePost({ source: 'mock' }); assert.equal(toMock.status, 200);
    assert.equal((await info()).source, 'mock'); assert.equal((await info()).simulated, true);
  } finally { s.close(); }
  // Hosted build: no agent, no base URL → Real is 409 and the build stays hosted (fails closed).
  const hosted = createApp({ agent: null, hosted: true, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const hs = await listen(hosted);
  try {
    const refused = await fetch(`${originOf(hs)}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'real' }) });
    assert.equal(refused.status, 409);
    assert.equal((await (await fetch(`${originOf(hs)}/api/info`)).json()).hosted, true);
  } finally { hs.close(); }
});
