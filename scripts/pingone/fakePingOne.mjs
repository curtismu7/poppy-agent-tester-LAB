// In-process fake of the slice of the PingOne API that scripts/pingone uses. One node:http server on 127.0.0.1 serves
// both the auth host (/{env}/as/...) and the management host (/v1/environments/{env}/...). Used only by tests.
//   const fake = createFakePingOne({ envId, workerClientId, workerSecret });
//   const base = await fake.listen();   // http://127.0.0.1:<port>
// It validates request shapes the way the tests expect, logs every request in `requests`, and can
// fail the next matching request with failNext(). A second export, createHarness, wires a fake, a temp dir and
// scripted prompts together for the three test files.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

export const TEST_ENV_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_WORKER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const TEST_SECRET = 'WORKER-SECRET-9f3a7c1d-never-leak';

const json = (res, status, body, headers = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
};
const VALID_NAME = /^[\p{L}\p{M}\p{N} \/.'_-]+$/u; // measured against a real tenant 2026-11-17 (resource create)
const perr = (status, code, message, details) => ({ status, body: { id: crypto.randomUUID(), code, message, ...(details ? { details } : {}) } });
const hal = (key, items) => ({ _embedded: { [key]: items }, count: items.length });

export function createFakePingOne({
  envId = TEST_ENV_ID,
  workerEnvId = envId, // the environment the worker lives in (its /as/token); PingOne workers often live in the administrator environment
  workerClientId = TEST_WORKER_ID,
  workerSecret = TEST_SECRET,
  rejectBasic = false, // true: the token endpoint answers 401 to Basic and accepts only credentials in the body
  openidIssuer, // what the metadata document claims; default is the canonical issuer for this fake's tld below
  populations = [{ id: crypto.randomUUID(), name: 'Default', default: true }],
} = {}) {
  const db = { resources: [], scopes: [], apps: [], grants: [], users: [], populations: populations.map((p) => ({ ...p })), tokens: new Set(), passwords: new Map() };
  const requests = [];
  const failures = [];
  const config = { rejectBasic };
  let server;
  let base = '';

  const matchFailure = (method, p) => {
    const i = failures.findIndex((f) => f.method === method && (f.pattern instanceof RegExp ? f.pattern.test(p) : p === f.pattern || p.endsWith(f.pattern)));
    return i === -1 ? null : failures.splice(i, 1)[0];
  };

  function token(req, body) {
    const ok = (id, secret) => id === workerClientId && secret === workerSecret;
    let granted = false;
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Basic ') && !config.rejectBasic) {
      const [id, ...rest] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      granted = ok(id, rest.join(':'));
    } else if (!auth) {
      const form = new URLSearchParams(body);
      granted = ok(form.get('client_id'), form.get('client_secret'));
    }
    if (new URLSearchParams(body).get('grant_type') !== 'client_credentials') return perr(400, 'INVALID_REQUEST', 'unsupported grant_type');
    if (!granted) return { status: 401, body: { error: 'invalid_client', error_description: 'Request denied: Unauthorized' } };
    const access = `fake-token-${crypto.randomBytes(12).toString('hex')}`;
    db.tokens.add(access);
    return { status: 200, body: { access_token: access, token_type: 'Bearer', expires_in: 3600 } };
  }

  const notFound = (what, id) => perr(404, 'NOT_FOUND', `Unable to find ${what} with ID: '${id}'`);
  const byId = (list, id) => list.find((x) => x.id === id);
  const appView = (a) => ({ ...a });

  function validateApp(b) {
    const bad = [];
    if (typeof b.name !== 'string' || !b.name) bad.push({ code: 'REQUIRED_VALUE', target: 'name', message: 'name is required' });
    if (b.type !== 'WEB_APP') bad.push({ code: 'INVALID_VALUE', target: 'type', message: 'type must be WEB_APP' });
    if (b.protocol !== 'OPENID_CONNECT') bad.push({ code: 'INVALID_VALUE', target: 'protocol', message: 'protocol must be OPENID_CONNECT' });
    if (b.tokenEndpointAuthMethod !== 'PRIVATE_KEY_JWT') bad.push({ code: 'INVALID_VALUE', target: 'tokenEndpointAuthMethod', message: 'must be PRIVATE_KEY_JWT' });
    if (!Array.isArray(b.redirectUris) || !b.redirectUris.length) bad.push({ code: 'EMPTY_VALUE', target: 'redirectUris', message: 'redirectUris must not be empty' });
    if (!Array.isArray(b.grantTypes) || !b.grantTypes.includes('AUTHORIZATION_CODE')) bad.push({ code: 'INVALID_VALUE', target: 'grantTypes', message: 'grantTypes must contain AUTHORIZATION_CODE' });
    if (!Array.isArray(b.responseTypes) || !b.responseTypes.includes('CODE')) bad.push({ code: 'INVALID_VALUE', target: 'responseTypes', message: 'responseTypes must contain CODE' });
    if (!['OPTIONAL', 'REQUIRED', 'S256_REQUIRED'].includes(b.pkceEnforcement ?? 'OPTIONAL')) bad.push({ code: 'INVALID_VALUE', target: 'pkceEnforcement', message: 'unknown value' });
    if (!['OPTIONAL', 'REQUIRED'].includes(b.parRequirement ?? 'OPTIONAL')) bad.push({ code: 'INVALID_VALUE', target: 'parRequirement', message: 'unknown value' });
    // Docs (Create application, OIDC web app): postLogoutRedirectUris is listed as Required.
    if (!Array.isArray(b.postLogoutRedirectUris) || !b.postLogoutRedirectUris.every((u) => typeof u === 'string' && u)) bad.push({ code: 'REQUIRED_VALUE', target: 'postLogoutRedirectUris', message: 'postLogoutRedirectUris is required' });
    if (typeof b.jwks !== 'string') bad.push({ code: 'INVALID_VALUE', target: 'jwks', message: 'jwks must be a JSON string' });
    else {
      let doc;
      try { doc = JSON.parse(b.jwks); } catch { /* reported below */ }
      if (!Array.isArray(doc?.keys) || !doc.keys.length) bad.push({ code: 'INVALID_VALUE', target: 'jwks', message: 'jwks must parse to {keys:[...]} with at least one key' });
      else if (doc.keys.some((k) => 'd' in k)) bad.push({ code: 'INVALID_VALUE', target: 'jwks', message: 'jwks must hold public keys only' });
      else if (doc.keys.some((k) => typeof k.kid !== 'string' || !k.kid)) bad.push({ code: 'INVALID_VALUE', target: 'jwks', message: 'every key needs a kid' });
    }
    return bad;
  }

  function management(req, method, p, query, raw) {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!db.tokens.has(auth)) return { status: 401, body: { id: crypto.randomUUID(), code: 'ACCESS_FAILED', message: 'Invalid token' } };
    let body;
    if (raw) { try { body = JSON.parse(raw); } catch { return perr(400, 'INVALID_DATA', 'Request body is not JSON'); } }
    let m;

    if (p === '/resources') {
      if (method === 'GET') return { status: 200, body: hal('resources', db.resources) };
      if (method === 'POST') {
        const missing = [];
        for (const k of ['name', 'audience', 'introspectEndpointAuthMethod']) if (typeof body?.[k] !== 'string' || !body[k]) missing.push({ code: 'REQUIRED_VALUE', target: k, message: `${k} is required` });
        if (missing.length) return perr(400, 'INVALID_DATA', 'The request could not be completed. One or more validation errors were in the request.', missing);
        if (!VALID_NAME.test(String(body?.name ?? '')) || /^PingOne API$/i.test(body.name)) return perr(400, 'INVALID_DATA', 'Validation Error : [name must only contain letters, marks, numbers, spaces, forward slashes, dots, apostrophes, underscores, or hyphens (real tenant rule)]');
        if (db.resources.some((r) => r.audience === body.audience || r.name === body.name)) return perr(400, 'INVALID_DATA', 'Uniqueness violation', [{ code: 'UNIQUENESS_VIOLATION', target: 'audience', message: 'audience or name already exists' }]);
        const r = { id: crypto.randomUUID(), type: 'CUSTOM', ...body };
        db.resources.push(r);
        return { status: 201, body: r };
      }
    }
    if ((m = /^\/resources\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if (!byId(db.resources, m[1])) return notFound('Resource', m[1]);
      db.resources = db.resources.filter((r) => r.id !== m[1]);
      db.scopes = db.scopes.filter((x) => x.resourceId !== m[1]);
      db.grants = db.grants.filter((g) => g.resourceId !== m[1]);
      return { status: 204 };
    }
    if ((m = /^\/resources\/([^/]+)\/scopes$/.exec(p))) {
      if (!byId(db.resources, m[1])) return notFound('Resource', m[1]);
      if (method === 'GET') return { status: 200, body: hal('scopes', db.scopes.filter((x) => x.resourceId === m[1]).map(({ resourceId, ...x }) => x)) };
      if (method === 'POST') {
        if (typeof body?.name !== 'string' || !body.name) return perr(400, 'INVALID_DATA', 'name is required');
        if (db.scopes.some((x) => x.resourceId === m[1] && x.name === body.name)) return perr(400, 'INVALID_DATA', 'Uniqueness violation', [{ code: 'UNIQUENESS_VIOLATION', target: 'name' }]);
        const sc = { id: crypto.randomUUID(), resourceId: m[1], ...body };
        db.scopes.push(sc);
        const { resourceId, ...view } = sc;
        return { status: 201, body: view };
      }
    }
    if ((m = /^\/resources\/([^/]+)\/scopes\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if (!db.scopes.some((x) => x.id === m[2] && x.resourceId === m[1])) return notFound('Scope', m[2]);
      db.scopes = db.scopes.filter((x) => x.id !== m[2]);
      return { status: 204 };
    }

    if (p === '/applications') {
      if (method === 'GET') {
        const f = /^name eq "(.*)"$/.exec(query.get('filter') ?? '');
        if (query.get('filter') && !f) return perr(400, 'REQUEST_FAILED', 'invalid filter');
        return { status: 200, body: hal('applications', db.apps.filter((a) => !f || a.name === f[1]).map(appView)) };
      }
      if (method === 'POST') {
        const bad = validateApp(body ?? {});
        if (bad.length) return perr(400, 'INVALID_DATA', 'The request could not be completed. One or more validation errors were in the request.', bad);
        if (db.apps.some((a) => a.name === body.name)) return perr(400, 'INVALID_DATA', 'Uniqueness violation', [{ code: 'UNIQUENESS_VIOLATION', target: 'name', message: 'name must be unique' }]);
        const a = { id: crypto.randomUUID(), ...body };
        db.apps.push(a);
        return { status: 201, body: appView(a) };
      }
    }
    if ((m = /^\/applications\/([^/]+)$/.exec(p))) {
      const a = byId(db.apps, m[1]);
      if (!a) return notFound('Application', m[1]);
      if (method === 'GET') return { status: 200, body: appView(a) };
      if (method === 'DELETE') {
        db.apps = db.apps.filter((x) => x.id !== m[1]);
        db.grants = db.grants.filter((g) => g.appId !== m[1]);
        return { status: 204 };
      }
    }
    if ((m = /^\/applications\/([^/]+)\/grants$/.exec(p))) {
      if (!byId(db.apps, m[1])) return notFound('Application', m[1]);
      if (method === 'GET') return { status: 200, body: hal('grants', db.grants.filter((g) => g.appId === m[1]).map(({ appId, resourceId, ...g }) => g)) };
      if (method === 'POST') {
        const rid = body?.resource?.id;
        if (!byId(db.resources, rid)) return perr(400, 'INVALID_DATA', 'resource.id does not exist', [{ code: 'INVALID_VALUE', target: 'resource.id' }]);
        if (!Array.isArray(body.scopes) || !body.scopes.length || !body.scopes.every((x) => db.scopes.some((s) => s.id === x?.id && s.resourceId === rid))) return perr(400, 'INVALID_DATA', 'scopes must belong to the resource', [{ code: 'INVALID_VALUE', target: 'scopes' }]);
        if (db.grants.some((g) => g.appId === m[1] && g.resourceId === rid)) return perr(400, 'INVALID_DATA', 'An application cannot have multiple grants for the same resource');
        const g = { id: crypto.randomUUID(), appId: m[1], resourceId: rid, resource: { id: rid }, scopes: body.scopes.map((x) => ({ id: x.id })) };
        db.grants.push(g);
        const { appId, resourceId, ...view } = g;
        return { status: 201, body: view };
      }
    }
    if ((m = /^\/applications\/([^/]+)\/grants\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if (!db.grants.some((g) => g.id === m[2] && g.appId === m[1])) return notFound('Grant', m[2]);
      db.grants = db.grants.filter((g) => g.id !== m[2]);
      return { status: 204 };
    }

    if (p === '/populations' && method === 'GET') return { status: 200, body: hal('populations', db.populations) };
    if (p === '/users') {
      if (method === 'GET') {
        const f = /^username eq "(.*)"$/.exec(query.get('filter') ?? '');
        return { status: 200, body: hal('users', db.users.filter((u) => !f || u.username.toLowerCase() === f[1].toLowerCase())) };
      }
      if (method === 'POST') {
        if (typeof body?.username !== 'string' || !body.username) return perr(400, 'INVALID_DATA', 'username is required', [{ code: 'REQUIRED_VALUE', target: 'username' }]);
        if (!byId(db.populations, body.population?.id)) return perr(400, 'INVALID_DATA', 'population.id is required', [{ code: 'REQUIRED_VALUE', target: 'population.id' }]);
        if (db.users.some((u) => u.username.toLowerCase() === body.username.toLowerCase())) return perr(400, 'INVALID_DATA', 'Uniqueness violation', [{ code: 'UNIQUENESS_VIOLATION', target: 'username' }]);
        const u = { id: crypto.randomUUID(), ...body, enabled: true };
        db.users.push(u);
        return { status: 201, body: u };
      }
    }
    if ((m = /^\/users\/([^/]+)\/password$/.exec(p)) && method === 'PUT') {
      if (!byId(db.users, m[1])) return notFound('User', m[1]);
      if (req.headers['content-type'] !== 'application/vnd.pingidentity.password.set+json') return perr(415, 'INVALID_REQUEST', 'wrong media type for a password set');
      const v = body?.value;
      if (typeof v !== 'string' || v.length < 12 || !/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/\d/.test(v)) return perr(400, 'INVALID_VALUE', 'password does not meet the password policy');
      if (typeof body.forceChange !== 'boolean') return perr(400, 'INVALID_DATA', 'forceChange is required');
      db.passwords.set(m[1], v);
      return { status: 200, body: { status: body.forceChange ? 'MUST_CHANGE_PASSWORD' : 'OK' } };
    }
    if ((m = /^\/users\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if (!byId(db.users, m[1])) return notFound('User', m[1]);
      db.users = db.users.filter((u) => u.id !== m[1]);
      db.passwords.delete(m[1]);
      return { status: 204 };
    }
    return perr(404, 'NOT_FOUND', `no fake route for ${method} ${p}`);
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    requests.push({ method: req.method, path: p, query: url.search, url: req.url, headers: { ...req.headers }, body: raw });

    const failure = matchFailure(req.method, p);
    if (failure) return json(res, failure.status, failure.body);

    let m;
    if ((m = /^\/([^/]+)\/as\/(.*)$/.exec(p))) {
      if (m[2] === 'token' && req.method === 'POST') {
        if (m[1] !== workerEnvId) return json(res, 404, { code: 'NOT_FOUND', message: 'unknown environment' });
        const r = token(req, raw); return json(res, r.status, r.body);
      }
      if (m[1] !== envId) return json(res, 404, { code: 'NOT_FOUND', message: 'unknown environment' });
      if (m[2] === '.well-known/openid-configuration' && req.method === 'GET') {
        const issuer = openidIssuer ?? `https://auth.pingone.com/${envId}/as`;
        return json(res, 200, { issuer, pushed_authorization_request_endpoint: `${issuer}/par`, token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'] });
      }
      return json(res, 404, { code: 'NOT_FOUND' });
    }
    if ((m = /^\/v1\/environments\/([^/]+)(\/.*)$/.exec(p))) {
      if (m[1] !== envId) return json(res, 404, { code: 'NOT_FOUND', message: 'unknown environment' });
      const r = management(req, req.method, m[2], url.searchParams, raw);
      return json(res, r.status, r.body);
    }
    return json(res, 404, { code: 'NOT_FOUND' });
  }

  return {
    db,
    requests,
    config,
    envId,
    workerEnvId,
    workerClientId,
    workerSecret,
    /** Fails the next request whose method equals `method` and whose path equals/ends with/matches `pathPattern`. */
    failNext(method, pathPattern, status, body = { code: 'FORCED_FAILURE', message: 'forced by the test' }) { failures.push({ method, pattern: pathPattern, status, body }); },
    async listen() {
      server = http.createServer((req, res) => { handle(req, res).catch((e) => { json(res, 500, { code: 'FAKE_ERROR', message: String(e?.message) }); }); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    close: () => new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); }),
    get base() { return base; },
    posts: () => requests.filter((r) => r.method === 'POST' && !r.path.endsWith('/as/token')),
  };
}

// ------------------------------------------------------------------------------------------------- test harness

class Capture extends Writable {
  constructor() { super(); this.text = ''; }
  _write(chunk, _enc, cb) { this.text += chunk.toString('utf8'); cb(); }
}

/** A fake, a temp working dir, captured stdout/stderr and scripted prompts. */
export async function createHarness({ fake: fakeOpts = {}, answers = {} } = {}) {
  const fake = createFakePingOne(fakeOpts);
  const base = await fake.listen();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-pingone-'));
  const asked = [];
  const secretAsked = [];
  const make = (over = {}) => {
    const stdout = new Capture();
    const stderr = new Capture();
    const a = { envId: fake.envId, workerId: fake.workerClientId, secret: fake.workerSecret, demoUser: 'n', ...answers, ...over.answers };
    const prompt = {
      async ask(question, { default: dflt } = {}) {
        asked.push(question);
        if (/environment id/i.test(question)) return a.envId;
        if (/worker client id/i.test(question)) return a.workerId;
        if (/demo user/i.test(question)) return a.demoUser ?? dflt ?? '';
        throw new Error(`unexpected question: ${question}`);
      },
      async secret(question) { secretAsked.push(question); return a.secret; },
    };
    return { stdout, stderr, deps: { fetch, prompt, bases: { auth: base, api: base }, cwd, stdout, stderr, env: {}, ...over.deps } };
  };
  return {
    fake, base, cwd, make, asked, secretAsked,
    file: (...p) => path.join(cwd, ...p),
    envFile: path.join(cwd, '.env'),
    stateFile: path.join(cwd, '.data', 'pingone-state.json'),
    readState: () => JSON.parse(fs.readFileSync(path.join(cwd, '.data', 'pingone-state.json'), 'utf8')),
    async close() { await fake.close(); fs.rmSync(cwd, { recursive: true, force: true }); },
  };
}

/** Every file under dir, as { file, text }. */
export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push({ file: f, text: fs.readFileSync(f, 'utf8') });
  }
  return out;
}
