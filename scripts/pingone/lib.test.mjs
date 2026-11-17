// node --test scripts/pingone/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { Readable } from 'node:stream';
import {
  SafeError, createApi, describeError, updateEnvFile, removeEnvValues, readEnvValue, readState, writeState, STATE_SCHEMA,
  normalizeBaseUrl, generatePassword, readSecret, parseSetupArgs, parseTeardownArgs, jwksString, applicationDiffs, basesFor, issuerFor,
  checkName, checkUuid, checkAudience, resolvePaths, readEnvLine,
} from './lib.mjs';
import { loadAgentKey } from '../../server/src/agentKey.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const mode = (f) => fs.statSync(f).mode & 0o777;

test('updateEnvFile keeps every unrelated line byte for byte, replaces owned keys in place, appends the rest in order', (t) => {
  const file = path.join(tmp(t), '.env');
  const before = [
    '# a comment with PAT_P1_CLIENT_ID=not-a-setting',
    '',
    'ANTHROPIC_API_KEY=sk-unrelated',
    'export PAT_DEMO_P1_ISSUER=https://old.invalid/x/as',
    '   # indented comment',
    'PAT_P1_CLIENT_ID=old-id',
    'PAT_AGENT_BASE_URL=http://127.0.0.1:5450',
    'TRAILING=keep me',
    '',
  ].join('\n');
  fs.writeFileSync(file, before, { mode: 0o644 });
  const { changed } = updateEnvFile(file, { PAT_P1_CLIENT_ID: 'new-id', PAT_DEMO_P1_ISSUER: 'https://new.invalid/y/as', COMPANY_ISSUER: 'https://new.invalid/y/as' },
    { PAT_AGENT_BASE_URL: 'http://127.0.0.1:9999', PAT_DEMO_COMPANY_ORIGIN: 'http://127.0.0.1:5452' });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, [
    '# a comment with PAT_P1_CLIENT_ID=not-a-setting',
    '',
    'ANTHROPIC_API_KEY=sk-unrelated',
    'export PAT_DEMO_P1_ISSUER=https://new.invalid/y/as',
    '   # indented comment',
    'PAT_P1_CLIENT_ID=new-id',
    'PAT_AGENT_BASE_URL=http://127.0.0.1:5450', // add-only key already present: untouched
    'TRAILING=keep me',
    'COMPANY_ISSUER=https://new.invalid/y/as',
    'PAT_DEMO_COMPANY_ORIGIN=http://127.0.0.1:5452',
    '',
  ].join('\n'));
  assert.deepEqual(changed.sort(), ['COMPANY_ISSUER', 'PAT_DEMO_COMPANY_ORIGIN', 'PAT_DEMO_P1_ISSUER', 'PAT_P1_CLIENT_ID']);
  assert.equal(mode(file), 0o600);
});

test('updateEnvFile creates a new file with mode 600, adds a missing final newline, and is a no-op the second time', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'sub', '.env');
  updateEnvFile(file, { A_KEY: '1' }, { B_KEY: '2' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=1\nB_KEY=2\n');
  assert.equal(mode(file), 0o600);
  const noNl = path.join(dir, 'x.env');
  fs.writeFileSync(noNl, 'KEEP=1');
  updateEnvFile(noNl, { A_KEY: '1' });
  assert.equal(fs.readFileSync(noNl, 'utf8'), 'KEEP=1\nA_KEY=1\n');
  const { changed } = updateEnvFile(noNl, { A_KEY: '1' });
  assert.deepEqual(changed, []);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
});

test('updateEnvFile preserves CRLF endings on a replaced line and rejects values with a newline, writing nothing', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, 'A_KEY=old\r\nOTHER=1\r\n');
  updateEnvFile(file, { A_KEY: 'new' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=new\r\nOTHER=1\r\n');
  for (const bad of ['a\nb', 'a\rb', '', 'a\0b']) {
    assert.throws(() => updateEnvFile(file, { A_KEY: bad }), SafeError);
    assert.throws(() => updateEnvFile(file, {}, { NEW_KEY: bad }), SafeError);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=new\r\nOTHER=1\r\n');
});

test('removeEnvValues removes a line only while its value still equals the recorded one', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, 'A_KEY=mine\nB_KEY=edited-by-user\nexport C_KEY=mine\nKEEP=1\n', { mode: 0o644 });
  const { removed } = removeEnvValues(file, { A_KEY: 'mine', B_KEY: 'mine', C_KEY: 'mine', MISSING: 'x' });
  assert.deepEqual(removed.sort(), ['A_KEY', 'C_KEY']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'B_KEY=edited-by-user\nKEEP=1\n');
  assert.equal(mode(file), 0o600);
  assert.deepEqual(removeEnvValues(path.join(path.dirname(file), 'missing.env'), { A_KEY: 'mine' }), { removed: [], restored: [] });
});

test('readEnvValue reads plain, exported and quoted values and returns null when absent', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, 'A=1\nexport B="two"\nC=\'three\'\n');
  assert.equal(readEnvValue(file, 'A'), '1');
  assert.equal(readEnvValue(file, 'B'), 'two');
  assert.equal(readEnvValue(file, 'C'), 'three');
  assert.equal(readEnvValue(file, 'D'), null);
  assert.equal(readEnvValue(path.join(path.dirname(file), 'nope'), 'A'), null);
});

test('state file round trip is mode 600; a foreign or corrupt file is refused', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'd', 'pingone-state.json');
  assert.equal(readState(file), null);
  writeState(file, { schema: STATE_SCHEMA, objects: {}, env: {} });
  assert.equal(mode(file), 0o600);
  assert.equal(readState(file).schema, STATE_SCHEMA);
  fs.writeFileSync(file, '{"schema":"other/1","objects":{}}');
  assert.throws(() => readState(file), /not a pat-pingone\/1 file/);
  fs.writeFileSync(file, 'not json');
  assert.throws(() => readState(file), /not valid JSON/);
});

test('describeError prints status, code, message and details and nothing else', () => {
  const line = describeError(400, { id: 'x', code: 'INVALID_DATA', message: 'bad', details: [{ code: 'INVALID_VALUE', target: 'jwks', message: 'no' }], extra: 'ignored' });
  assert.equal(line, 'HTTP 400 INVALID_DATA: bad [INVALID_VALUE (jwks) no]');
  assert.equal(describeError(502, undefined), 'HTTP 502');
});

test('createApi scrubs the worker secret and the token out of anything PingOne echoes back', async () => {
  const secret = 'S3CRET-VALUE-xyz';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 'TOKEN-123', expires_in: 1 }), { status: 200 });
    return new Response(JSON.stringify({ code: 'NOPE', message: `echo ${secret} and TOKEN-123` }), { status: 400 });
  };
  const api = createApi({ authBase: 'http://a.invalid', apiBase: 'http://b.invalid', fetchImpl });
  const token = await api.mintToken('env', 'client', secret);
  const s = api.session('env', token);
  await assert.rejects(() => s.get('/resources'), (e) => {
    assert.ok(!e.message.includes(secret) && !e.message.includes('TOKEN-123'), e.message);
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
  assert.equal(calls[0].init.redirect, 'error', 'never follow a redirect with credentials attached');
});

test('createApi: a network failure names the host only, never the request', async () => {
  const api = createApi({ authBase: 'http://a.invalid', apiBase: 'http://b.invalid', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed http://a.invalid/x?secret=1'), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(() => api.mintToken('env', 'c', 'pw'), (e) => { assert.equal(e.message, 'network error calling a.invalid (ECONNREFUSED)'); return true; });
});

test('createApi: delete maps 404 to gone, 204 to deleted and anything else throws', async () => {
  const statuses = [204, 404, 500];
  const api = createApi({ authBase: 'http://a.invalid', apiBase: 'http://b.invalid', fetchImpl: async () => new Response(null, { status: statuses.shift() }) });
  const s = api.session('env', 't');
  assert.equal(await s.del('/x'), 'deleted');
  assert.equal(await s.del('/x'), 'gone');
  await assert.rejects(() => s.del('/x'), /HTTP 500/);
});

test('normalizeBaseUrl accepts origins, refuses paths, credentials and non-loopback http', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5450/'), 'http://127.0.0.1:5450');
  assert.equal(normalizeBaseUrl('http://localhost:5450'), 'http://localhost:5450');
  assert.equal(normalizeBaseUrl('https://lab.example:5451'), 'https://lab.example:5451');
  for (const bad of ['http://lab.example:5450', 'https://lab.example/path', 'https://u:p@lab.example', 'https://lab.example/?q=1', 'ftp://x', 'nope']) {
    assert.throws(() => normalizeBaseUrl(bad), SafeError, bad);
  }
});

test('generatePassword: 24 characters, four classes, different each time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const pw = generatePassword();
    assert.ok(pw.length >= 20);
    assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /\d/); assert.match(pw, /[-_.!@#%]/);
    seen.add(pw);
  }
  assert.equal(seen.size, 50);
});

test('readSecret refuses to run without a terminal', async () => {
  const stdin = Readable.from([]);
  await assert.rejects(() => readSecret('secret: ', { stdin, stdout: { write() {} } }), /run in a terminal/);
});

test('readSecret on a terminal does not echo what is typed', async () => {
  const written = [];
  const listeners = [];
  const stdin = {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
    on: (_e, fn) => listeners.push(fn), removeListener() {},
  };
  const p = readSecret('secret: ', { stdin, stdout: { write: (s) => written.push(s) } });
  listeners[0]('ab');
  listeners[0]('x\u007fc\r');
  assert.equal(await p, 'abc');
  assert.ok(!written.join('').includes('ab'), 'the typed text is never written back');
  assert.equal(written[0], 'secret: ');
});

test('the CLIs have no way to take the secret or a custom host', () => {
  for (const flag of ['--secret', '--worker-secret', '--client-secret', '--auth-base', '--api-base', '--bases']) {
    assert.throws(() => parseSetupArgs([flag, 'x']), undefined, flag);
    assert.throws(() => parseTeardownArgs([flag, 'x']), undefined, flag);
  }
  const o = parseSetupArgs(['--region', 'eu', '--base-url', 'https://x.example:1', '--demo-user', '--env-file', 'a', '--state-file', 'b', '--name', 'n', '--audience', 'aud']);
  assert.deepEqual(o, { region: 'eu', baseUrl: 'https://x.example:1', name: 'n', audience: 'aud', envFile: 'a', stateFile: 'b', workerEnvId: undefined, demoUser: true, help: undefined });
});

test('jwksString holds public members only and matches the agent key; applicationDiffs compares redirect and kid', (t) => {
  const agent = loadAgentKey(tmp(t));
  const doc = JSON.parse(jwksString(agent));
  assert.deepEqual(Object.keys(doc.keys[0]).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  assert.equal(doc.keys[0].kid, agent.kid);
  assert.equal(doc.keys[0].alg, 'ES256');
  assert.throws(() => jwksString({ ...agent, publicJwk: { ...agent.publicJwk, d: 'x' } }), /private member/);
  const app = { redirectUris: ['http://127.0.0.1:5450/cb'], jwks: jwksString(agent) };
  assert.deepEqual(applicationDiffs(app, { baseUrl: 'http://127.0.0.1:5450', kid: agent.kid }), []);
  assert.deepEqual(applicationDiffs(app, { baseUrl: 'http://127.0.0.1:9', kid: agent.kid }), ['redirectUris']);
  assert.deepEqual(applicationDiffs({ ...app, jwks: undefined }, { baseUrl: 'http://127.0.0.1:5450', kid: agent.kid }), ['jwks']);
  assert.deepEqual(applicationDiffs({ ...app, jwks: '{"keys":[{"kid":"other"}]}' }, { baseUrl: 'http://127.0.0.1:5450', kid: agent.kid }), ['jwks']);
});

test('hosts, issuer, name and uuid checks', () => {
  assert.deepEqual(basesFor('eu'), { auth: 'https://auth.pingone.eu', api: 'https://api.pingone.eu' });
  assert.equal(issuerFor('com', 'e1'), 'https://auth.pingone.com/e1/as');
  assert.throws(() => checkName('bad"name'), SafeError);
  assert.throws(() => checkUuid('nope', 'x'), SafeError);
  const p = resolvePaths({ cwd: '/w', env: { PAT_DATA_DIR: 'data2' } });
  assert.equal(p.stateFile, '/w/data2/pingone-state.json');
  assert.equal(p.envFile, '/w/.env');
});

// ---- review findings (2026-11-17)

test('finding: atomicWrite follows a symlinked .env or state file instead of replacing the link', (t) => {
  const dir = tmp(t);
  const real = path.join(dir, 'real.env');
  const link = path.join(dir, '.env');
  fs.writeFileSync(real, 'A=1\nPAT_P1_CLIENT_ID=old\n');
  fs.symlinkSync(real, link);
  updateEnvFile(link, { PAT_P1_CLIENT_ID: 'abc' });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
  assert.equal(fs.readFileSync(real, 'utf8'), 'A=1\nPAT_P1_CLIENT_ID=abc\n');
  removeEnvValues(link, { PAT_P1_CLIENT_ID: 'abc' });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, 'utf8'), 'A=1\n');
  const stateReal = path.join(dir, 'state-real.json');
  const stateLink = path.join(dir, 'state.json');
  fs.symlinkSync(stateReal, stateLink); // dangling link: the target does not exist yet
  writeState(stateLink, { schema: STATE_SCHEMA, objects: {}, env: {} });
  assert.equal(fs.lstatSync(stateLink).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(stateReal, 'utf8')).schema, STATE_SCHEMA);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('finding: keys are matched literally, so a hostile key cannot delete other lines or hang the process', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, `DATABASE_URL=secretval\nAXB=2\n${'a'.repeat(40)}!=x\n`);
  const before = fs.readFileSync(file, 'utf8');
  const started = Date.now();
  assert.deepEqual(removeEnvValues(file, { '[A-Z_]+': 'secretval', '(a+)+$': 'x', 'A.B': '2' }), { removed: [], restored: [] });
  assert.ok(Date.now() - started < 1000, 'no catastrophic backtracking');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  updateEnvFile(file, { 'A.B': '1' });
  assert.equal(fs.readFileSync(file, 'utf8'), `${before}A.B=1\n`, 'A.B did not replace AXB');
});

test('finding: KEY = value with spaces is the same line to this editor as it is to Node', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, 'PAT_AGENT_BASE_URL = http://127.0.0.1:5461\nPAT_P1_CLIENT_ID = old\nexport COMPANY_ISSUER  =  x\n');
  assert.equal(readEnvValue(file, 'PAT_AGENT_BASE_URL'), 'http://127.0.0.1:5461');
  updateEnvFile(file, { PAT_P1_CLIENT_ID: 'new', COMPANY_ISSUER: 'y' }, { PAT_AGENT_BASE_URL: 'http://127.0.0.1:5450' });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter((l) => l.startsWith('PAT_AGENT_BASE_URL')).length, 1, 'no duplicate add-only line');
  const parsed = util.parseEnv(text);
  assert.equal(parsed.PAT_AGENT_BASE_URL, 'http://127.0.0.1:5461', 'the user value still wins');
  assert.equal(parsed.PAT_P1_CLIENT_ID, 'new');
  assert.equal(parsed.COMPANY_ISSUER, 'y');
  assert.equal(text.split('\n').filter((l) => l.includes('PAT_P1_CLIENT_ID')).length, 1);
  assert.deepEqual(removeEnvValues(file, { PAT_P1_CLIENT_ID: 'new' }).removed, ['PAT_P1_CLIENT_ID']);
});

test('finding: a value Node would read differently (# comment, backtick, quote) is refused, not written', (t) => {
  const file = path.join(tmp(t), '.env');
  for (const bad of ['https://c.example/a#b', 'a`b`', 'say "hi"', "it's"]) {
    assert.throws(() => updateEnvFile(file, { COMPANY_AUDIENCE: bad }), SafeError, bad);
    assert.throws(() => checkAudience(bad), SafeError, bad);
  }
  assert.equal(fs.existsSync(file), false);
  for (const ok of ['https://c.example/a?b=1$x', 'urn:company:poppy']) {
    updateEnvFile(file, { COMPANY_AUDIENCE: ok });
    assert.equal(util.parseEnv(fs.readFileSync(file, 'utf8')).COMPANY_AUDIENCE, ok);
  }
});

test('finding: appended lines use the file\'s own line ending', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, '# c\r\nPAT_P1_CLIENT_ID=old\r\nX=1');
  updateEnvFile(file, { PAT_P1_CLIENT_ID: 'n', COMPANY_ISSUER: 'i' }, { PAT_AGENT_BASE_URL: 'http://127.0.0.1:5450' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# c\r\nPAT_P1_CLIENT_ID=n\r\nX=1\r\nCOMPANY_ISSUER=i\r\nPAT_AGENT_BASE_URL=http://127.0.0.1:5450\r\n');
  const lf = path.join(path.dirname(file), 'lf.env');
  fs.writeFileSync(lf, 'A=1\n');
  updateEnvFile(lf, { B: '2' });
  assert.equal(fs.readFileSync(lf, 'utf8'), 'A=1\nB=2\n');
});

test('finding: a replaced owned line can be put back exactly (readEnvLine, then removeEnvValues with previous)', (t) => {
  const file = path.join(tmp(t), '.env');
  fs.writeFileSync(file, '# keep\nexport COMPANY_AUDIENCE = "https://mine.example/keep"\nOTHER=1\nPAT_P1_CLIENT_ID=old\n');
  const prev = readEnvLine(file, 'COMPANY_AUDIENCE');
  assert.equal(prev, 'export COMPANY_AUDIENCE = "https://mine.example/keep"');
  assert.equal(readEnvLine(file, 'MISSING'), null);
  updateEnvFile(file, { COMPANY_AUDIENCE: 'https://company.example/poppy' });
  const r = removeEnvValues(file, { COMPANY_AUDIENCE: 'https://company.example/poppy', PAT_P1_CLIENT_ID: 'old' }, { COMPANY_AUDIENCE: prev });
  assert.deepEqual([r.removed, r.restored], [['PAT_P1_CLIENT_ID'], ['COMPANY_AUDIENCE']]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# keep\nexport COMPANY_AUDIENCE = "https://mine.example/keep"\nOTHER=1\n');
});

test('finding: a state file with path-like ids, foreign env keys or loose previous lines is refused whole', (t) => {
  const file = path.join(tmp(t), 'state.json');
  const good = { schema: STATE_SCHEMA, objects: { application: { id: '11111111-2222-4333-8444-555555555555', created: true } }, env: { PAT_P1_CLIENT_ID: 'x' } };
  const refuses = (over, re) => { fs.writeFileSync(file, JSON.stringify({ ...good, ...over })); assert.throws(() => readState(file), re); };
  fs.writeFileSync(file, JSON.stringify(good));
  assert.ok(readState(file));
  refuses({ objects: { user: { id: '../applications/victim', created: true } } }, /not a UUID/);
  refuses({ objects: { user: { id: '../../../../v1/environments/99999999-2222-4333-8444-555555555555/users/x', created: true } } }, /not a UUID/);
  refuses({ objects: { grant: { id: 7, created: true } } }, /not a UUID/);
  refuses({ objects: { grant: null } }, /not a UUID|not an object/);
  refuses({ objects: { user: { id: '11111111-2222-4333-8444-555555555555', populationId: '../x', created: true } } }, /not a UUID/);
  refuses({ workerEnvironmentId: '../x' }, /not a UUID/);
  refuses({ env: { '[A-Z_]+': 'secretval' } }, /env key/);
  refuses({ env: { PAT_P1_CLIENT_ID: 5 } }, /env/);
  refuses({ envPrevious: { DATABASE_URL: 'DATABASE_URL=x' } }, /env key/);
  refuses({ envPrevious: { COMPANY_AUDIENCE: 'EVIL=1\nCOMPANY_AUDIENCE=x' } }, /previous/);
  refuses({ envPrevious: { COMPANY_AUDIENCE: 'OTHER_KEY=1' } }, /previous/);
});

test('finding: createApi.addSecret scrubs a later secret (the generated demo password) out of errors', async () => {
  const api = createApi({ authBase: 'http://127.0.0.1:1', apiBase: 'http://127.0.0.1:1', fetchImpl: async (url, init) => new Response(JSON.stringify({ code: 'BAD', message: `echo ${init.body}` }), { status: 400 }) });
  const s = api.session('11111111-2222-4333-8444-555555555555', 'tok');
  api.addSecret('P4ssw0rd-never-show');
  await assert.rejects(s.put('/users/x/password', { value: 'P4ssw0rd-never-show' }), (e) => !e.message.includes('P4ssw0rd-never-show') && /\[redacted\]/.test(e.message));
});

test('finding: --worker-env-id is parsed for setup and teardown', () => {
  assert.equal(parseSetupArgs(['--worker-env-id', 'abc']).workerEnvId, 'abc');
  assert.equal(parseTeardownArgs(['--worker-env-id', 'abc']).workerEnvId, 'abc');
});
