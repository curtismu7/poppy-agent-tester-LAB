import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCompanyApp } from '../src/app.js';
import { buildWorld, genEc, genRsa, athOf, ME, ISSUER, AUDIENCE, AGENT_ID, ORIGIN } from './helpers.js';

let w; let server; let port;
const logged = [];
const realLog = { log: console.log, error: console.error, warn: console.warn, info: console.info };

before(async () => {
  for (const k of Object.keys(realLog)) console[k] = (...a) => logged.push(a.join(' '));
  w = buildWorld();
  server = http.createServer(createCompanyApp({ config: w.config, fetchImpl: w.fetchImpl, now: w.clk.now }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { Object.assign(console, realLog); server.close(); });

/** A raw request so any header (Host, X-Forwarded-*) can be set. */
const call = (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body; try { body = JSON.parse(text); } catch { body = text; }
      resolve({ status: res.statusCode, headers: res.headers, body, text });
    });
  });
  r.on('error', reject);
  r.end();
});
const me = ({ session, version = '1.0', bearer, authorization } = {}) => call(ME, { headers: {
  ...(session === undefined ? {} : { 'poppy-session': session }), ...(version === null ? {} : { 'poppy-version': version }),
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(authorization !== undefined ? { authorization } : {}),
} });
const signedIn = (sessionOver = {}, tokenOver = {}) => { const token = w.token(tokenOver); return { token, session: w.session(sessionOver, { token }) }; };
const err = (r, status, code) => { assert.equal(r.status, status, r.text); assert.equal(r.body.error, code, r.text); assert.equal(typeof r.body.error_description, 'string'); };

test('GET /.well-known/poppy.json', async () => {
  const r = await call('/.well-known/poppy.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=300');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.deepEqual(r.body, {
    protocol_version: '1.0',
    organization: { name: 'Reference Company', domain: '127.0.0.1:5452' },
    auth: { issuer: ISSUER, scopes: { 'accounts:read': "Read the signed-in user's account summary" }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } },
    apis: [{ type: 'openapi', url: `${ORIGIN}/poppy/api/openapi.json`, description: 'Account summary for the signed-in user' }],
  });
});

test('GET /.well-known/oauth-protected-resource: resource equals the origin exactly', async () => {
  const r = await call('/.well-known/oauth-protected-resource');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=300');
  assert.deepEqual(r.body, { resource: ORIGIN, authorization_servers: [ISSUER], scopes_supported: ['accounts:read'], bearer_methods_supported: ['header'] });
});

test('GET /poppy/api/openapi.json and /healthz', async () => {
  const o = await call('/poppy/api/openapi.json');
  assert.equal(o.status, 200);
  assert.equal(o.body.openapi, '3.1.0');
  assert.deepEqual(Object.keys(o.body.paths), [ME]);
  assert.deepEqual(o.body.paths[ME].get.security, [{ oauth: ['accounts:read'] }]);
  assert.equal(o.headers['cache-control'], 'no-store');
  const h = await call('/healthz');
  assert.deepEqual([h.status, h.body, h.headers['cache-control']], [200, { ok: true }, 'no-store']);
});

test('unknown paths are 404, non-GET is 405 with Allow: GET', async () => {
  for (const p of ['/', '/nope', '/poppy/api/v1/me/', '/.well-known/poppy.json/x', '//evil.example/healthz', '/__proto__', '/constructor']) {
    const r = await call(p);
    assert.deepEqual([p, r.status, r.body], [p, 404, { error: 'not_found' }]);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const r = await call(ME, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET');
    if (method !== 'HEAD') assert.deepEqual(r.body, { error: 'method_not_allowed' });
  }
});

test('finding: the route is the raw request path; backslashes, dot segments and malformed targets are 404, never normalized and never 500', async () => {
  for (const p of ['/\\evil.example/poppy/api/v1/me', '/\\evil.example/healthz', '/poppy/api/x/../v1/me', '/./healthz', '/healthz/..', '/poppy/api/v1/%2e%2e/v1/me', '/poppy%2fapi/v1/me', '/\\\\:', '/\\:80', '/%5chealthz', '/healthz%00']) {
    const r = await call(p);
    assert.deepEqual([p, r.status, r.body], [p, 404, { error: 'not_found' }]);
  }
  // A query string is still not part of the path (htu has none), and is ignored for routing.
  assert.equal((await call('/healthz?x=1')).status, 200);
  const { token, session } = signedIn({}, {});
  assert.equal((await call(`${ME}?x=1`, { headers: { 'poppy-session': session, 'poppy-version': '1.0', authorization: `Bearer ${token}` } })).status, 200);
});

test('/me, step 1: no Poppy-Session is 400 invalid_session, before the version and the bearer', async () => {
  err(await me({}), 400, 'invalid_session');
  err(await me({ version: null, bearer: 'garbage' }), 400, 'invalid_session');
  err(await me({ session: '' }), 400, 'invalid_session');
  err(await me({ session: '   ' }), 400, 'invalid_session');
});

test('/me, step 2: Poppy-Version missing or not 1.x is 400 version_unsupported, before the bearer', async () => {
  const session = w.session();
  err(await me({ session, version: null }), 400, 'version_unsupported');
  for (const v of ['2.0', '0.9', '1', '1.', '1.x', 'v1.0', '1.0.1', '']) err(await me({ session, version: v, bearer: 'garbage' }), 400, 'version_unsupported');
  assert.equal((await me({ session: w.session(), version: '1.0' })).status, 200);
  assert.equal((await me({ session: w.session(), version: '1.12' })).status, 200);
});

test('/me, step 3: a DPoP or other scheme is 401 invalid_token, with a Bearer challenge', async () => {
  const session = w.session();
  for (const authorization of [`DPoP ${w.token()}`, 'Basic dXNlcjpwdw==', 'Bearer', 'Bearer ', `Bearer a b`, '']) {
    const r = await me({ session, authorization });
    err(r, 401, 'invalid_token');
    assert.equal(r.headers['www-authenticate'], 'Bearer error="invalid_token"');
  }
  const lower = signedIn();
  assert.equal((await me({ session: lower.session, authorization: `bearer ${lower.token}` })).status, 200, 'the scheme name is case-insensitive');
});

test('/me, step 3: token failures are 401 invalid_token with WWW-Authenticate, and the body has no token text', async () => {
  const cases = [{ aud: 'https://other.example' }, { exp: w.clk.sec() - 30 }, { iss: 'https://evil.example' }, { cnf: { jkt: 'x' } }, { client_id: undefined }];
  for (const over of cases) {
    const { token, session } = signedIn({}, over);
    const r = await me({ session, bearer: token });
    err(r, 401, 'invalid_token');
    assert.equal(r.headers['www-authenticate'], 'Bearer error="invalid_token"');
    assert.ok(!r.text.includes(token) && !r.text.includes(session));
  }
});

test('/me, step 3: a token without the scope is 403 insufficient_scope with scope in the body and the challenge', async () => {
  const { token, session } = signedIn({}, { scope: 'openid' });
  const r = await me({ session, bearer: token });
  err(r, 403, 'insufficient_scope');
  assert.equal(r.body.scope, 'accounts:read');
  assert.equal(r.headers['www-authenticate'], 'Bearer error="insufficient_scope", scope="accounts:read"');
});

test('/me, step 3 comes before the session: a bad token wins over a bad session', async () => {
  const { token } = signedIn({}, { aud: 'x' });
  err(await me({ session: 'not-a-jws', bearer: token }), 401, 'invalid_token');
});

test('/me signed out: 200 with no user_id', async () => {
  const r = await me({ session: w.session({ sid: 'out-1', sub: 'user-9' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { state: 'signed_out', session_id: 'out-1', agent_id: AGENT_ID, scopes: [] });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('/me signed in: 200, scopes from the token, user_id is the session sub (never the token sub)', async () => {
  const { token, session } = signedIn({ sid: 'in-1', sub: 'session-sub' }, { sub: 'token-sub-that-must-not-leak', scope: 'openid accounts:read' });
  const r = await me({ session, bearer: token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { state: 'signed_in', user_id: 'session-sub', session_id: 'in-1', agent_id: AGENT_ID, scopes: ['openid', 'accounts:read'] });
  assert.ok(!r.text.includes('token-sub-that-must-not-leak'));
});

test('/me step 4: session failures are 400 invalid_session', async () => {
  err(await me({ session: 'abc' }), 400, 'invalid_session');
  err(await me({ session: w.session({ aud: 'https://other.example' }) }), 400, 'invalid_session');
  err(await me({ session: w.session({ iss: 'x' }, { delegation: w.delegation({ iss: 'x' }) }) }), 400, 'invalid_session');
  // A valid token, but the session was made for another token: ath mismatch.
  const { token } = signedIn();
  err(await me({ session: w.session({}, { token: w.token() }), bearer: token }), 400, 'invalid_session');
  // A token issued to a different client than the session iss.
  const t2 = w.token({ client_id: 'other-client' });
  err(await me({ session: w.session({}, { token: t2 }), bearer: t2 }), 400, 'invalid_session');
});

test('/me replay: the identical request twice is 200 then 400 invalid_session', async () => {
  const { token, session } = signedIn();
  assert.equal((await me({ session, bearer: token })).status, 200);
  const again = await me({ session, bearer: token });
  err(again, 400, 'invalid_session');
  assert.match(again.body.error_description, /jti was already used/);
});

test('/me: sid bound to a user', async () => {
  assert.equal((await me({ session: w.session({ sid: 'bound', sub: 'u1' }) })).status, 200);
  const r = await me({ session: w.session({ sid: 'bound', sub: 'u2' }) });
  err(r, 400, 'invalid_session');
  assert.match(r.body.error_description, /another user/);
});

test('htu comes from configuration, not Host or X-Forwarded-*', async () => {
  const session = w.session();
  const r = await call(ME, { headers: { host: 'evil.example:9', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-port': '443', 'poppy-session': session, 'poppy-version': '1.0' } });
  assert.equal(r.status, 200, r.text);
  // A session signed for the Host the request claimed is refused.
  const spoofed = w.session({ htu: `https://evil.example${ME}` });
  const r2 = await call(ME, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'poppy-session': spoofed, 'poppy-version': '1.0' } });
  err(r2, 400, 'invalid_session');
  assert.match(r2.body.error_description, /htu/);
});

test('a query string does not change the path the session is checked against', async () => {
  const r = await call(`${ME}?a=1#x`, { headers: { 'poppy-session': w.session(), 'poppy-version': '1.0' } });
  assert.equal(r.status, 200, r.text);
});

test('unregistered agent: a Company configured for another client refuses the session', async () => {
  const other = http.createServer(createCompanyApp({ config: { ...w.config, agentClientId: 'another-client' }, fetchImpl: w.fetchImpl, now: w.clk.now }));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${other.address().port}${ME}`, { headers: { 'poppy-session': w.session(), 'poppy-version': '1.0' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error_description, /agent is not registered/);
  } finally { other.close(); }
});

test('AS keys down: 503 temporarily_unavailable on a bearer request, signed-out requests still work', async () => {
  const w2 = buildWorld();
  const fetchImpl = async (url) => (String(url) === w2.config.issuerJwksUri ? new Response('x', { status: 500 }) : w2.fetchImpl(url));
  const s = http.createServer(createCompanyApp({ config: w2.config, fetchImpl, now: w2.clk.now }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const token = w2.token();
    const base = `http://127.0.0.1:${s.address().port}${ME}`;
    const down = await fetch(base, { headers: { authorization: `Bearer ${token}`, 'poppy-session': w2.session({}, { token }), 'poppy-version': '1.0' } });
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error, 'temporarily_unavailable');
    const out = await fetch(base, { headers: { 'poppy-session': w2.session(), 'poppy-version': '1.0' } });
    assert.equal(out.status, 200);
  } finally { s.close(); }
});

test('nothing is logged, whatever the request', () => {
  assert.deepEqual(logged, []);
});

test('the key sets serve only the configured URLs, never one from a request', async () => {
  w.fetchImpl.calls.length = 0;
  const hostile = w.session({}, { header: { jku: 'https://evil.example/jwks', x5u: 'https://evil.example/x' } });
  await me({ session: hostile });
  const delegation = w.delegation({ jku: 'https://evil.example/jwks' }, { header: { jku: 'https://evil.example/jwks', jwk: genEc().publicJwk } });
  await me({ session: w.session({}, { delegation }), bearer: w.token({}, { header: { jku: 'https://evil.example/jwks' } }) });
  for (const c of w.fetchImpl.calls) assert.ok([w.config.issuerJwksUri, w.config.agentJwksUri].includes(c.url), c.url);
  assert.ok(w.fetchImpl.calls.length <= 2, 'cached after the first load');
});

const freePortInRange = async () => {
  for (let p = 5470; p <= 5499; p += 1) {
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error('no free port in 5470-5499');
};

test('node company/src/index.js runs standalone and serves the documents (D5)', async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
  const p = await freePortInRange();
  const env = { PATH: process.env.PATH, COMPANY_ORIGIN: `http://127.0.0.1:${p}`, COMPANY_PORT: String(p), COMPANY_ISSUER: ISSUER, COMPANY_AGENT_CLIENT_ID: AGENT_ID, COMPANY_ORG_NAME: 'Standalone Co', COMPANY_AUDIENCE: AUDIENCE, COMPANY_BIND: '127.0.0.1', COMPANY_ALLOW_LOOPBACK: '1', COMPANY_ISSUER_JWKS_URI: `${ISSUER}/jwks`, COMPANY_AGENT_JWKS_URI: 'http://127.0.0.1:5450/jwks.json' };
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no start line: ${out}`)), 5000); child.stdout.on('data', () => { if (/listening/.test(out)) { clearTimeout(t); resolve(); } }); child.on('exit', () => reject(new Error(`exited: ${out}`))); });
    const base = `http://127.0.0.1:${p}`;
    const poppy = await (await fetch(`${base}/.well-known/poppy.json`)).json();
    assert.equal(poppy.organization.domain, `127.0.0.1:${p}`);
    assert.equal(poppy.organization.name, 'Standalone Co');
    assert.equal((await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).resource, base);
    assert.equal((await fetch(`${base}/poppy/api/openapi.json`)).status, 200);
    const noSession = await fetch(`${base}${ME}`);
    assert.equal(noSession.status, 400);
    assert.equal((await noSession.json()).error, 'invalid_session');
    assert.equal(out.includes('Bearer'), false);
    assert.match(out, /^company: /);
    assert.equal(out.trim().split('\n').length, 1, 'one startup line');
  } finally { child.kill(); }
});

test('index.js exits 1 with a readable message when the config is bad', async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, COMPANY_ISSUER: ISSUER, COMPANY_AGENT_CLIENT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err2 = '';
  child.stderr.on('data', (d) => { err2 += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err2, /COMPANY_AGENT_CLIENT_ID is required/);
});

test('rsa helper sanity (an unrelated AS key cannot sign for this Company)', async () => {
  const forged = w.token({}, { key: genRsa('as-key-1').privateKey });
  const r = await me({ session: w.session({}, { token: forged }), bearer: forged });
  err(r, 401, 'invalid_token');
  assert.equal(athOf('x').length, 43);
});
