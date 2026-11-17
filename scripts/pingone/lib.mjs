// Shared helpers for the PingOne setup and teardown scripts: the management API client, object finders and
// creators, the .env editor, the state file, prompts and the demo-user password generator.
//
// Property names and routes below were checked against the PingOne API docs on 2026-11-17
// (developer.pingidentity.com/pingone-api, pages "Create application (OIDC protocol - web app)", "Applications data
// model", "Create resource", "Create custom resource scope", "Create grant", "Read all populations", "Create user",
// "Update password (set)", and the Delete pages). Anything the docs do not settle is tagged UNVERIFIED.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadAgentKey } from '../../server/src/agentKey.js';
import { jwksDocument } from '../../server/src/agent.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_SCHEMA = 'pat-pingone/1';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The PingOne API docs region table (auth/working-with-pingone-apis, checked 2026-11-17) lists these tlds for auth.pingone.<tld> and api.pingone.<tld>.
export const REGIONS = ['com', 'ca', 'eu', 'com.au', 'sg', 'asia'];
export const DEFAULT_NAME = 'Poppy Agent Tester';
export const DEFAULT_AUDIENCE = 'https://company.example/poppy';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:5450';
export const COMPANY_ORIGIN_DEFAULT = 'http://127.0.0.1:5452';
export const SCOPE_NAME = 'accounts:read';
export const SCOPE_DESCRIPTION = "Read the signed-in user's account summary";
// PingOne (real tenant, 2026-11-17): a name may hold only letters, marks, numbers, spaces, / . ' _ - ; parentheses are refused.
export const RESOURCE_NAME = 'Poppy Company API reference';
export const resourceNameFor = (appName) => (appName === DEFAULT_NAME ? RESOURCE_NAME : `${appName} Company API reference`);
// The .env keys setup owns (replaced in place, removed or restored by teardown) and the ones it only adds when absent.
export const OWNED_ENV_KEYS = ['PAT_P1_CLIENT_ID', 'PAT_DEMO_P1_ISSUER', 'COMPANY_ISSUER', 'COMPANY_AUDIENCE', 'COMPANY_AGENT_CLIENT_ID', 'COMPANY_AGENT_JWKS_URI'];
export const ADD_ONLY_ENV_KEYS = ['PAT_AGENT_BASE_URL', 'PAT_DEMO_COMPANY_ORIGIN'];
export const DEMO_USERNAME = 'poppy-demo';
export const DEMO_EMAIL = 'poppy-demo@demo.example';

/** An error whose message is safe to print: it never holds a secret, a request or a header. */
export class SafeError extends Error {
  constructor(message, { hint, status, code } = {}) {
    super(message);
    this.name = 'SafeError';
    this.hint = hint;
    this.status = status;
    this.code = code;
  }
}

export const basesFor = (region) => ({ auth: `https://auth.pingone.${region}`, api: `https://api.pingone.${region}` });
export const issuerFor = (region, envId) => `https://auth.pingone.${region}/${envId}/as`;

// ---------------------------------------------------------------------------------------------------- API client

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export const embedded = (body, key) => (Array.isArray(body?._embedded?.[key]) ? body._embedded[key] : []);

/** Turns a PingOne error body into one printable line: status, code, message, details. Nothing from the request. */
export function describeError(status, body) {
  let line = `HTTP ${status}`;
  if (body && typeof body === 'object') {
    if (body.code) line += ` ${body.code}`;
    if (body.message) line += `: ${body.message}`;
    if (Array.isArray(body.details) && body.details.length) {
      line += ` [${body.details.map((x) => [x?.code, x?.target && `(${x.target})`, x?.message].filter(Boolean).join(' ')).join('; ')}]`;
    }
  }
  return line.length > 900 ? `${line.slice(0, 900)}...` : line;
}

export function createApi({ authBase, apiBase, fetchImpl = fetch, timeoutMs = 30000 }) {
  const secrets = new Set();
  const scrub = (text) => {
    let t = String(text);
    for (const s of secrets) if (s) t = t.split(s).join('[redacted]');
    return t;
  };

  async function send(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new SafeError(scrub(`network error calling ${new URL(url).host} (${e?.cause?.code || e?.name || 'failed'})`));
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
  }
  const fail = (res, extra = {}) => new SafeError(scrub(describeError(res.status, res.body)), { status: res.status, code: res.body?.code, ...extra });

  /**
   * Step 1: client_credentials with Basic; on 401 retry once with the credentials in the body (CLIENT_SECRET_POST worker).
   * workerEnvId is the environment the worker application lives in (its /as/token), which is not always the environment being set up.
   */
  async function mintToken(workerEnvId, clientId, secret) {
    secrets.add(secret);
    const url = `${authBase}/${workerEnvId}/as/token`;
    const grant = 'grant_type=client_credentials';
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    let res = await send(url, { method: 'POST', headers: { ...headers, authorization: `Basic ${b64(`${clientId}:${secret}`)}` }, body: grant });
    if (res.status === 401) {
      const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret });
      res = await send(url, { method: 'POST', headers, body: form.toString() });
    }
    if (res.status === 401 || res.status === 400 || res.status === 404) {
      throw fail(res, { hint: 'worker credentials rejected (check the environment id and the worker; a worker that lives in another environment needs --worker-env-id)' });
    }
    if (!res.ok) throw fail(res);
    const token = res.body?.access_token;
    if (typeof token !== 'string' || !token) throw new SafeError('token endpoint answered without an access_token');
    secrets.add(token);
    return token;
  }

  function session(envId, token) {
    const root = `${apiBase}/v1/environments/${envId}`;
    const call = async (method, p, { body, contentType = 'application/json' } = {}) => {
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = contentType;
      return send(`${root}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const need = (res, p = '') => {
      if (!res.ok) throw fail(res, res.status === 403 ? { hint: /^\/(users|populations)/.test(p) ? 'the worker cannot manage users in this environment: give it the Identity Data Admin role there, or skip --demo-user' : 'the worker needs Environment Admin in this environment' } : {});
      return res;
    };
    return {
      get: async (p) => need(await call('GET', p), p).body,
      post: async (p, body) => need(await call('POST', p, { body }), p).body,
      put: async (p, body, contentType) => need(await call('PUT', p, { body, contentType }), p).body,
      /** Resolves 'deleted' or 'gone' (404). Any other status throws. */
      del: async (p) => {
        const res = await call('DELETE', p);
        if (res.status === 404) return 'gone';
        need(res);
        return 'deleted';
      },
    };
  }

  /** Step 0: no credentials, never throws. */
  async function discover(envId) {
    try {
      const res = await send(`${authBase}/${envId}/as/.well-known/openid-configuration`, { method: 'GET', headers: { accept: 'application/json' } });
      return res.ok ? res.body : null;
    } catch { return null; }
  }

  /** Registers a secret learned later (the generated demo password) so it is scrubbed out of every error message. */
  const addSecret = (secret) => { if (secret) secrets.add(secret); };

  return { mintToken, session, discover, scrub, addSecret };
}

// ------------------------------------------------------------------------------------- object finders and creators

export async function findResource(s, audience) {
  return embedded(await s.get('/resources?limit=200'), 'resources').find((r) => r.audience === audience) ?? null;
}
// introspectEndpointAuthMethod is "Required" in the docs request model; the enum value CLIENT_SECRET_BASIC is UNVERIFIED.
export const createResource = (s, { audience, name = RESOURCE_NAME }) => s.post('/resources', {
  name,
  description: 'Reference Company for the Poppy Agent Tester',
  audience,
  accessTokenValiditySeconds: 3600,
  introspectEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
});

export async function findScope(s, resourceId, name) {
  return embedded(await s.get(`/resources/${resourceId}/scopes`), 'scopes').find((x) => x.name === name) ?? null;
}
export const createScope = (s, resourceId) => s.post(`/resources/${resourceId}/scopes`, { name: SCOPE_NAME, description: SCOPE_DESCRIPTION });

export async function findApplication(s, name) {
  const filter = encodeURIComponent(`name eq "${name}"`);
  return embedded(await s.get(`/applications?filter=${filter}`), 'applications').find((a) => a.name === name) ?? null;
}
export const getApplication = (s, id) => s.get(`/applications/${id}`);

/** The inline `jwks` property is a JSON string. Only public members go in; a private `d` aborts the run. */
export function jwksString(agent) {
  if ('d' in agent.publicJwk) throw new SafeError('agent key object holds a private member; refusing to register it');
  const { kty, crv, x, y, kid, alg, use } = jwksDocument(agent.publicJwk, agent.kid).keys[0];
  return JSON.stringify({ keys: [{ kty, crv, x, y, kid, alg, use }] });
}

// Property names verified in the docs: grantTypes, responseTypes, redirectUris, tokenEndpointAuthMethod PRIVATE_KEY_JWT,
// pkceEnforcement S256_REQUIRED, parRequirement REQUIRED, jwks (string), enabled. `signing` is optional (only its
// keyRotationPolicy is required when `signing` is present), so it is left out.
// postLogoutRedirectUris is "Required" in the docs request model, so it is sent (the agent origin; the lab never logs out). UNVERIFIED: whether a
// real tenant needs it at all or accepts an http loopback value there.
// UNVERIFIED: that one create accepts jwks + PRIVATE_KEY_JWT + parRequirement together, an EC P-256 / ES256 key in
// jwks (the docs show RSA examples only), and an http loopback redirect URI.
export const createApplication = (s, { name, baseUrl, jwks }) => s.post('/applications', {
  name,
  description: 'Poppy Agent Tester, registered client',
  enabled: true,
  type: 'WEB_APP',
  protocol: 'OPENID_CONNECT',
  grantTypes: ['AUTHORIZATION_CODE'],
  responseTypes: ['CODE'],
  redirectUris: [`${baseUrl}/cb`],
  postLogoutRedirectUris: [baseUrl],
  tokenEndpointAuthMethod: 'PRIVATE_KEY_JWT',
  pkceEnforcement: 'S256_REQUIRED',
  parRequirement: 'REQUIRED',
  jwks,
});

/** Compares an existing app with what setup would create. Returns the list of differences (empty when it matches). */
export function applicationDiffs(app, { baseUrl, kid }) {
  const diffs = [];
  if (!Array.isArray(app.redirectUris) || !app.redirectUris.includes(`${baseUrl}/cb`)) diffs.push('redirectUris');
  let keys = [];
  try { keys = JSON.parse(app.jwks)?.keys ?? []; } catch { /* a missing or malformed jwks counts as a difference */ }
  if (!Array.isArray(keys) || !keys.some((k) => k?.kid === kid)) diffs.push('jwks');
  return diffs;
}

export async function findGrant(s, appId, resourceId) {
  return embedded(await s.get(`/applications/${appId}/grants`), 'grants').find((g) => g.resource?.id === resourceId) ?? null;
}
export const createGrant = (s, appId, resourceId, scopeId) => s.post(`/applications/${appId}/grants`, { resource: { id: resourceId }, scopes: [{ id: scopeId }] });

// Docs: Read all populations. The data model lists `default` as a string type but it is a boolean flag; both forms are accepted.
export async function findDefaultPopulation(s) {
  const pops = embedded(await s.get('/populations'), 'populations');
  return pops.find((p) => p.default === true || p.default === 'true') ?? pops[0] ?? null;
}
// UNVERIFIED: the SCIM `filter=username eq "..."` form on GET /users.
export async function findUser(s, username) {
  const filter = encodeURIComponent(`username eq "${username}"`);
  return embedded(await s.get(`/users?filter=${filter}`), 'users').find((u) => u.username === username) ?? null;
}
export const createUser = (s, populationId) => s.post('/users', {
  username: DEMO_USERNAME,
  email: DEMO_EMAIL,
  name: { given: 'Poppy', family: 'Demo' },
  population: { id: populationId },
});
// Docs: "Update password (set)": PUT /users/{id}/password, media type application/vnd.pingidentity.password.set+json,
// body {value, forceChange}; cleartext is allowed and checked against the password policy.
export const setUserPassword = (s, userId, value) => s.put(`/users/${userId}/password`, { value, forceChange: false }, 'application/vnd.pingidentity.password.set+json');

/** 24 characters from four classes, via node:crypto. */
export function generatePassword(length = 24) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_.!@#%'];
  const all = sets.join('');
  const chars = sets.map((set) => set[crypto.randomInt(set.length)]);
  while (chars.length < Math.max(length, 20)) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// ------------------------------------------------------------------------------------------------- .env editor

// Keys are matched literally (a key is never a pattern) and, like Node's own env parser, `KEY = value` with spaces is the same line as `KEY=value`.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINE_RE = (key) => new RegExp(`^(\\s*(?:export\\s+)?)${escapeRe(key)}\\s*=\\s*(.*?)(\\r?)$`);
const unquote = (v) => { const t = v.trim(); return /^(['"]).*\1$/.test(t) && t.length > 1 ? t.slice(1, -1) : t; };

// Values go in bare. Node's env parser reads # as a comment and quotes or backticks as quoting, so a value holding one would be read back changed.
export const UNSAFE_VALUE = /[\r\n\0#`'"]/;
function assertValue(key, value) {
  if (typeof value !== 'string' || value === '' || UNSAFE_VALUE.test(value)) throw new SafeError(`refusing to write ${key}: the value is empty or contains a newline, #, quote or backtick`);
}

/** Follows symlinks (also dangling ones) so the real file is replaced, not the link. */
function resolveLink(file) {
  for (let i = 0; i < 16; i += 1) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st?.isSymbolicLink()) return file;
    file = path.resolve(path.dirname(file), fs.readlinkSync(file));
  }
  throw new SafeError(`too many symbolic links at ${file}`);
}

function atomicWrite(requested, text) {
  const file = resolveLink(requested);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function readEnvValue(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split('\n')) {
    const m = LINE_RE(key).exec(line);
    if (m) found = unquote(m[2]);
  }
  return found;
}

/** The last raw line that sets `key` (without its line ending), or null. Used to remember what setup is about to replace. */
export function readEnvLine(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split('\n')) if (LINE_RE(key).test(line)) found = line.replace(/\r$/, '');
  return found;
}

/**
 * Replaces owned keys in place (every occurrence), appends missing owned keys in the given order, and appends add-only
 * keys only when absent. Every other line stays byte for byte. Atomic, mode 600. Returns the keys it added or changed.
 */
export function updateEnvFile(file, owned, addOnly = {}) {
  for (const [k, v] of [...Object.entries(owned), ...Object.entries(addOnly)]) assertValue(k, v);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const lines = text === '' ? [] : text.split('\n');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const changed = [];
  const seen = new Set();
  const out = lines.map((line) => {
    for (const [k, v] of Object.entries(owned)) {
      const m = LINE_RE(k).exec(line);
      if (m) {
        seen.add(k);
        if (unquote(m[2]) === v && m[2] === v) return line;
        changed.push(k);
        return `${m[1]}${k}=${v}${m[3]}`;
      }
    }
    for (const k of Object.keys(addOnly)) if (LINE_RE(k).test(line)) seen.add(k);
    return line;
  });
  const appended = [];
  for (const [k, v] of Object.entries(owned)) if (!seen.has(k)) { appended.push(`${k}=${v}`); changed.push(k); }
  for (const [k, v] of Object.entries(addOnly)) if (!seen.has(k)) { appended.push(`${k}=${v}`); changed.push(k); }
  let next = out.join('\n');
  if (appended.length) {
    if (next !== '' && !next.endsWith('\n')) next += eol;
    next += `${appended.join(eol)}${eol}`;
  }
  if (next !== text) atomicWrite(file, next);
  else if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  return { changed };
}

/**
 * Removes a line only when its current value still equals the recorded one. When `previous[key]` holds the raw line that setup
 * replaced, that line is put back instead of removing. Returns the keys removed and the keys restored.
 */
export function removeEnvValues(file, expected, previous = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { removed: [], restored: [] }; }
  const removed = [];
  const restored = [];
  const out = [];
  for (const line of text.split('\n')) {
    let replacement = null;
    let drop = false;
    for (const [k, v] of Object.entries(expected)) {
      const m = LINE_RE(k).exec(line);
      if (!m || unquote(m[2]) !== v) continue;
      if (previous[k] === undefined) { removed.push(k); drop = true; }
      else if (!restored.includes(k)) { restored.push(k); replacement = `${previous[k]}${m[3]}`; }
      else drop = true;
      break;
    }
    if (replacement !== null) out.push(replacement);
    else if (!drop) out.push(line);
  }
  if (removed.length || restored.length) atomicWrite(file, out.join('\n'));
  else fs.chmodSync(file, 0o600);
  return { removed, restored };
}

// ---------------------------------------------------------------------------------------------------- state file

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const shown = (v) => JSON.stringify(String(v)).slice(0, 40);

/** The state file is read back as input, so it is checked like input: ids go into URLs, env keys into patterns, previous lines into .env. */
function validateState(state, file) {
  const refuse = (what) => new SafeError(`state file ${file} ${what}`);
  for (const [kind, obj] of Object.entries(state.objects)) {
    if (obj === null || typeof obj !== 'object' || !isUuid(obj.id)) throw refuse(`holds an id for "${shown(kind)}" that is not a UUID`);
    if (obj.populationId !== undefined && !isUuid(obj.populationId)) throw refuse(`holds a populationId for "${shown(kind)}" that is not a UUID`);
  }
  if (state.workerEnvironmentId !== undefined && !isUuid(state.workerEnvironmentId)) throw refuse('holds a worker environment id that is not a UUID');
  const known = [...OWNED_ENV_KEYS, ...ADD_ONLY_ENV_KEYS];
  for (const field of ['env', 'envPrevious']) {
    const map = state[field];
    if (map === undefined) continue;
    if (map === null || typeof map !== 'object' || Array.isArray(map)) throw refuse(`has no valid ${field} object`);
    for (const [k, v] of Object.entries(map)) {
      if (!known.includes(k)) throw refuse(`lists an env key this tool never writes (${shown(k)})`);
      if (typeof v !== 'string') throw refuse(`holds a non-text ${field} value`);
      if (field === 'envPrevious' && (/[\r\n\0]/.test(v) || !LINE_RE(k).test(v))) throw refuse(`holds a previous line for ${k} that is not a ${k} line`);
    }
  }
}

export function readState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let state;
  try { state = JSON.parse(text); } catch { throw new SafeError(`state file ${file} is not valid JSON`); }
  if (state?.schema !== STATE_SCHEMA || typeof state.objects !== 'object' || state.objects === null || Array.isArray(state.objects)) {
    throw new SafeError(`state file ${file} is not a ${STATE_SCHEMA} file`);
  }
  validateState(state, file);
  state.env ??= {};
  return state;
}
export const writeState = (file, state) => atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
export const removeState = (file) => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

export function resolvePaths({ cwd, env = {}, envFile, stateFile }) {
  const dataDir = env.PAT_DATA_DIR ? path.resolve(cwd, env.PAT_DATA_DIR) : path.join(cwd, '.data');
  return {
    dataDir,
    envFile: path.resolve(cwd, envFile ?? '.env'),
    stateFile: path.resolve(cwd, stateFile ?? path.join(dataDir, 'pingone-state.json')),
  };
}

export const loadAgent = (dataDir) => loadAgentKey(dataDir);

// ---------------------------------------------------------------------------------------------- input validation

export function normalizeBaseUrl(raw, label = '--base-url') {
  let u;
  try { u = new URL(raw); } catch { throw new SafeError(`${label} is not a URL: ${raw}`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new SafeError(`${label} must be an origin such as http://127.0.0.1:5450 (got ${raw})`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback) throw new SafeError(`${label} must be https unless the host is loopback (got ${raw})`);
  return u.origin;
}

export function checkName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,98}$/.test(name)) {
    throw new SafeError('--name must be 1-99 characters: letters, digits, space and . _ -');
  }
  return name;
}
export function checkAudience(aud) {
  if (typeof aud !== 'string' || !aud || /\s/.test(aud) || UNSAFE_VALUE.test(aud) || aud.length > 200) throw new SafeError('--audience must be a non-empty string without whitespace, #, quotes or backticks (it is written to .env as is)');
  return aud;
}
export function checkUuid(value, label) {
  if (!UUID_RE.test(String(value ?? '').trim())) throw new SafeError(`${label} is not a UUID`);
  return String(value).trim().toLowerCase();
}

export function parseSetupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      region: { type: 'string' }, 'base-url': { type: 'string' }, name: { type: 'string' }, audience: { type: 'string' },
      'env-file': { type: 'string' }, 'state-file': { type: 'string' }, 'worker-env-id': { type: 'string' }, 'demo-user': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  return {
    region: values.region, baseUrl: values['base-url'], name: values.name, audience: values.audience,
    envFile: values['env-file'], stateFile: values['state-file'], workerEnvId: values['worker-env-id'], demoUser: values['demo-user'], help: values.help,
  };
}
export function parseTeardownArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: { 'env-file': { type: 'string' }, 'state-file': { type: 'string' }, 'worker-env-id': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  return { envFile: values['env-file'], stateFile: values['state-file'], workerEnvId: values['worker-env-id'], help: values.help };
}

// ------------------------------------------------------------------------------------------------------- prompts

/** Reads a line with no echo (raw mode on a TTY). Refuses to run when stdin is not a terminal. */
export function readSecret(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.reject(new SafeError('run in a terminal: the worker secret is read without echo and needs a TTY'));
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (fn, arg) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); fn(arg); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(resolve, value);
        if (ch === '\u0003') return done(reject, new SafeError('aborted'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function createTerminalPrompt({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return {
    async ask(question, { default: dflt } = {}) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await rl.question(question)).trim();
        return answer === '' && dflt !== undefined ? dflt : answer;
      } finally { rl.close(); }
    },
    secret: (question) => readSecret(question, { stdin, stdout }),
  };
}

export function terminalOrThrow(stdin = process.stdin) {
  if (!stdin.isTTY) throw new SafeError('run in a terminal: this script prompts for the worker secret without echo');
}

export function printError(stderr, e) {
  // Only SafeError text is printed; any other error is named by type and code so no message of unknown content leaks.
  stderr.write(`error: ${e?.name === 'SafeError' ? e.message : `unexpected failure (${e?.code || e?.name || 'unknown'})`}\n`);
  if (e?.hint) stderr.write(`hint: ${e.hint}\n`);
}
