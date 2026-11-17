// node --test scripts/pingone/*.test.mjs
// Setup against the in-process fake PingOne only. No real tenant, no network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from './setup.mjs';
import { createHarness, walk, TEST_SECRET, TEST_WORKER_ID } from './fakePingOne.mjs';

const BASE = 'http://127.0.0.1:5450';
const mode = (f) => fs.statSync(f).mode & 0o777;
const harness = async (t, opts) => { const h = await createHarness(opts); t.after(() => h.close()); return h; };
const run = async (h, opts = {}, over = {}) => { const m = h.make(over); const r = await runSetup(opts, m.deps); return { ...r, stdout: m.stdout.text, stderr: m.stderr.text }; };
const envLines = (h) => Object.fromEntries(fs.readFileSync(h.envFile, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const b64Basic = Buffer.from(`${TEST_WORKER_ID}:${TEST_SECRET}`).toString('base64');
const agentD = (h) => JSON.parse(fs.readFileSync(h.file('.data', 'agent-key.json'), 'utf8')).d;

test('happy path: resource, scope, application and grant exist with the contract shapes; state and .env are right', async (t) => {
  const h = await harness(t);
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.stderr);

  const { db } = h.fake;
  assert.equal(db.resources.length, 1);
  assert.equal(db.resources[0].audience, 'https://company.example/poppy');
  assert.equal(db.resources[0].introspectEndpointAuthMethod, 'CLIENT_SECRET_BASIC');
  assert.equal(db.resources[0].accessTokenValiditySeconds, 3600);
  assert.equal(db.scopes.length, 1);
  assert.equal(db.scopes[0].name, 'accounts:read');
  assert.equal(db.apps.length, 1);
  const app = db.apps[0];
  assert.equal(app.name, 'Poppy Agent Tester');
  assert.equal(app.type, 'WEB_APP');
  assert.equal(app.protocol, 'OPENID_CONNECT');
  assert.equal(app.enabled, true);
  assert.deepEqual(app.grantTypes, ['AUTHORIZATION_CODE']);
  assert.deepEqual(app.responseTypes, ['CODE']);
  assert.deepEqual(app.redirectUris, [`${BASE}/cb`]);
  assert.equal(app.tokenEndpointAuthMethod, 'PRIVATE_KEY_JWT');
  assert.equal(app.pkceEnforcement, 'S256_REQUIRED');
  assert.equal(app.parRequirement, 'REQUIRED');
  assert.equal(typeof app.jwks, 'string', 'jwks is a serialized string');
  const key = JSON.parse(app.jwks).keys[0];
  assert.deepEqual(Object.keys(key).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  assert.equal(key.alg, 'ES256');
  assert.equal(key.crv, 'P-256');
  assert.equal(db.grants.length, 1);
  assert.equal(db.grants[0].resourceId, db.resources[0].id);
  assert.deepEqual(db.grants[0].scopes, [{ id: db.scopes[0].id }]);

  // requests: the documented paths only (never /applicationResourceGrants), management calls carry the bearer
  const paths = h.fake.requests.map((q) => `${q.method} ${q.path}`);
  assert.ok(paths.includes(`POST /v1/environments/${h.fake.envId}/applications/${app.id}/grants`));
  assert.ok(!paths.some((p) => p.includes('applicationResourceGrants')));
  for (const q of h.fake.requests.filter((x) => x.path.startsWith('/v1/'))) assert.match(q.headers.authorization, /^Bearer fake-token-/);

  // state file
  assert.equal(mode(h.stateFile), 0o600);
  const state = h.readState();
  assert.equal(state.schema, 'pat-pingone/1');
  assert.equal(state.environmentId, h.fake.envId);
  assert.equal(state.region, 'com');
  assert.equal(state.baseUrl, BASE);
  assert.deepEqual(state.objects.resource, { id: db.resources[0].id, audience: 'https://company.example/poppy', created: true });
  assert.deepEqual(state.objects.scope, { id: db.scopes[0].id, name: 'accounts:read', created: true });
  assert.deepEqual(state.objects.application, { id: app.id, name: 'Poppy Agent Tester', created: true });
  assert.deepEqual(state.objects.grant, { id: db.grants[0].id, created: true });
  assert.ok(!('user' in state.objects));

  // .env
  const issuer = `https://auth.pingone.com/${h.fake.envId}/as`;
  assert.deepEqual(envLines(h), {
    PAT_P1_CLIENT_ID: app.id,
    PAT_DEMO_P1_ISSUER: issuer,
    COMPANY_ISSUER: issuer,
    COMPANY_AUDIENCE: 'https://company.example/poppy',
    COMPANY_AGENT_CLIENT_ID: app.id,
    COMPANY_AGENT_JWKS_URI: `${BASE}/jwks.json`,
    PAT_AGENT_BASE_URL: BASE,
    PAT_DEMO_COMPANY_ORIGIN: 'http://127.0.0.1:5452',
  });
  assert.equal(mode(h.envFile), 0o600);
  assert.deepEqual(Object.keys(state.env).sort(), Object.keys(envLines(h)).sort());
  // never in .env or state: environment id as a key, worker id, region, secret
  const envText = fs.readFileSync(h.envFile, 'utf8');
  assert.ok(!envText.includes(TEST_WORKER_ID) && !envText.includes('WORKER'));
  assert.ok(!JSON.stringify(state).includes(TEST_WORKER_ID));
  assert.match(r.stdout, new RegExp(app.id));
});

test('idempotency: a second run makes no POST, exits 0, leaves .env and the state ids unchanged', async (t) => {
  const h = await harness(t);
  assert.equal((await run(h)).exitCode, 0);
  const env1 = fs.readFileSync(h.envFile, 'utf8');
  const state1 = h.readState();
  h.fake.requests.length = 0;
  const second = await run(h);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.deepEqual(h.fake.posts(), [], 'no object is created twice');
  assert.equal(h.fake.requests.filter((q) => q.method !== 'GET' && !q.path.endsWith('/as/token')).length, 0, 'GET only (plus the token)');
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), env1);
  const state2 = h.readState();
  assert.deepEqual(state2.objects, state1.objects, 'created:true is kept when a rerun adopts our own objects');
  assert.deepEqual(state2.env, state1.env);
  assert.equal(h.fake.db.apps.length, 1);
});

test('missing state file but the objects exist: they are adopted with created:false', async (t) => {
  const h = await harness(t);
  await run(h);
  fs.rmSync(h.stateFile);
  h.fake.requests.length = 0;
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(h.fake.posts(), []);
  const objs = h.readState().objects;
  for (const k of ['resource', 'scope', 'application', 'grant']) assert.equal(objs[k].created, false, k);
});

test('worker auth falls back to credentials in the body when Basic is refused', async (t) => {
  const h = await harness(t, { fake: { rejectBasic: true } });
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.stderr);
  const tokens = h.fake.requests.filter((q) => q.path.endsWith('/as/token'));
  assert.equal(tokens.length, 2);
  assert.match(tokens[0].headers.authorization, /^Basic /);
  assert.equal(tokens[1].headers.authorization, undefined);
  const form = new URLSearchParams(tokens[1].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), TEST_WORKER_ID);
  assert.equal(form.get('client_secret'), TEST_SECRET);
  assert.equal(h.fake.db.apps.length, 1);
});

test('a wrong worker secret aborts with a message that does not contain the secret, before any management call', async (t) => {
  const h = await harness(t);
  const wrong = 'WRONG-SECRET-do-not-print-me';
  const r = await run(h, {}, { answers: { secret: wrong } });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /worker credentials rejected/);
  for (const text of [r.stdout, r.stderr]) assert.ok(!text.includes(wrong) && !text.includes(TEST_SECRET));
  assert.ok(!r.stderr.includes(Buffer.from(`${TEST_WORKER_ID}:${wrong}`).toString('base64')));
  assert.equal(h.fake.requests.filter((q) => q.path.startsWith('/v1/')).length, 0);
  assert.equal(fs.existsSync(h.stateFile), false);
  assert.equal(fs.existsSync(h.envFile), false);
});

test('the worker secret is nowhere: not stdout, stderr, any file, any URL, or any body except the token credential', async (t) => {
  for (const rejectBasic of [false, true]) {
    const h = await harness(t, { fake: { rejectBasic } });
    const r = await run(h, {}, { answers: { demoUser: 'y' } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(!r.stdout.includes(TEST_SECRET) && !r.stderr.includes(TEST_SECRET));
    for (const { file, text } of walk(h.cwd)) {
      assert.ok(!text.includes(TEST_SECRET), `${file} holds the secret`);
      assert.ok(!text.includes(b64Basic), `${file} holds the Basic credential`);
    }
    for (const q of h.fake.requests) {
      assert.ok(!q.url.includes(TEST_SECRET), 'secret in a URL');
      if (q.path.endsWith('/as/token')) continue;
      assert.ok(!JSON.stringify(q).includes(TEST_SECRET), `secret in ${q.method} ${q.path}`);
      assert.ok(!JSON.stringify(q).includes(b64Basic), `Basic credential in ${q.method} ${q.path}`);
    }
    assert.deepEqual(h.secretAsked.length, 1, 'asked for the secret exactly once');
  }
});

test('the private key member d never appears in any request body or output', async (t) => {
  const h = await harness(t);
  const r = await run(h, {}, { answers: { demoUser: 'y' } });
  assert.equal(r.exitCode, 0, r.stderr);
  const d = agentD(h);
  assert.ok(d && d.length > 30, 'the agent key was created in the temp data dir');
  for (const q of h.fake.requests) assert.ok(!JSON.stringify(q).includes(d), `d in ${q.method} ${q.path}`);
  assert.ok(!r.stdout.includes(d) && !r.stderr.includes(d));
  assert.ok(!fs.readFileSync(h.envFile, 'utf8').includes(d));
  assert.ok(!fs.readFileSync(h.stateFile, 'utf8').includes(d));
  assert.ok(!h.fake.db.apps[0].jwks.includes(`"d"`));
});

test('.env: every unrelated line, the order, an existing PAT_AGENT_BASE_URL and the 600 mode survive', async (t) => {
  const h = await harness(t);
  const before = ['# my settings', '', 'ANTHROPIC_API_KEY=sk-unrelated', 'PAT_AGENT_BASE_URL=http://127.0.0.1:5450', 'export PAT_P1_CLIENT_ID=old', '# tail', ''].join('\n');
  fs.writeFileSync(h.envFile, before, { mode: 0o644 });
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.stderr);
  const lines = fs.readFileSync(h.envFile, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 4), ['# my settings', '', 'ANTHROPIC_API_KEY=sk-unrelated', 'PAT_AGENT_BASE_URL=http://127.0.0.1:5450']);
  assert.equal(lines[4], `export PAT_P1_CLIENT_ID=${h.fake.db.apps[0].id}`);
  assert.equal(lines[5], '# tail');
  assert.equal(mode(h.envFile), 0o600, 'a 644 file ends at 600');
  assert.equal(envLines(h).ANTHROPIC_API_KEY, 'sk-unrelated');
  // PAT_AGENT_BASE_URL was already there: this tool did not add it, so the state does not claim it
  assert.ok(!('PAT_AGENT_BASE_URL' in h.readState().env));
  assert.ok('PAT_DEMO_COMPANY_ORIGIN' in h.readState().env);
});

test('--base-url that disagrees with an existing PAT_AGENT_BASE_URL aborts naming both, before any request', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(h.envFile, 'PAT_AGENT_BASE_URL=http://127.0.0.1:5450\n');
  const r = await run(h, { baseUrl: 'http://127.0.0.1:5499' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /http:\/\/127\.0\.0\.1:5499/);
  assert.match(r.stderr, /http:\/\/127\.0\.0\.1:5450/);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), 'PAT_AGENT_BASE_URL=http://127.0.0.1:5450\n');
});

test('an existing PAT_AGENT_BASE_URL is used as the base when --base-url is absent; an equal --base-url is fine', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(h.envFile, 'PAT_AGENT_BASE_URL=http://localhost:5460\n');
  const r = await run(h, { baseUrl: 'http://localhost:5460' });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(h.fake.db.apps[0].redirectUris, ['http://localhost:5460/cb']);
  assert.equal(envLines(h).COMPANY_AGENT_JWKS_URI, 'http://localhost:5460/jwks.json');
});

test('input is validated before any request: bad ids, region, name, base url', async (t) => {
  const h = await harness(t);
  assert.equal((await run(h, {}, { answers: { envId: 'not-a-uuid' } })).exitCode, 1);
  assert.equal((await run(h, {}, { answers: { workerId: 'nope' } })).exitCode, 1);
  assert.equal((await run(h, { region: 'mars' })).exitCode, 1);
  assert.equal((await run(h, { name: 'a"b' })).exitCode, 1);
  assert.equal((await run(h, { baseUrl: 'http://lab.example:5450' })).exitCode, 1);
  assert.equal((await run(h, {}, { answers: { secret: '' } })).exitCode, 1);
  assert.equal(h.fake.requests.length, 0);
});

test('a 400 naming redirectUris prints PingOne error verbatim plus the --base-url hint, exits 1, no retry', async (t) => {
  const h = await harness(t);
  h.fake.failNext('POST', /\/applications$/, 400, { code: 'INVALID_DATA', message: 'bad request', details: [{ code: 'INVALID_VALUE', target: 'redirectUris', message: 'must be https' }] });
  const r = await run(h);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /HTTP 400 INVALID_DATA: bad request \[INVALID_VALUE \(redirectUris\) must be https\]/);
  assert.match(r.stderr, /rerun with --base-url https:\/\/<host>:<port>/);
  assert.equal(h.fake.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/applications')).length, 1, 'no automatic retry');
  assert.equal(fs.existsSync(h.envFile), false, '.env is only written after everything worked');
});

test('a 403 from PingOne adds the Environment Admin hint', async (t) => {
  const h = await harness(t);
  h.fake.failNext('POST', /\/resources$/, 403, { code: 'ACCESS_FAILED', message: 'The request could not be completed. You do not have access to this resource.' });
  const r = await run(h);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /HTTP 403 ACCESS_FAILED/);
  assert.match(r.stderr, /Environment Admin/);
});

test('a failure mid-run leaves the state of what was created, so teardown can clean up', async (t) => {
  const h = await harness(t);
  h.fake.failNext('POST', /\/scopes$/, 500, { code: 'UNEXPECTED', message: 'boom' });
  const r = await run(h);
  assert.equal(r.exitCode, 1);
  const state = h.readState();
  assert.equal(state.objects.resource.created, true);
  assert.ok(!('scope' in state.objects));
  assert.equal(fs.existsSync(h.envFile), false);
});

test('an existing application that differs aborts without changing anything', async (t) => {
  const h = await harness(t);
  await run(h);
  h.fake.db.apps[0].redirectUris = ['http://127.0.0.1:5461/cb'];
  const before = JSON.stringify(h.fake.db.apps);
  h.fake.requests.length = 0;
  const r = await run(h);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /application exists but differs; run teardown then setup/);
  assert.match(r.stderr, /redirectUris/);
  assert.deepEqual(h.fake.posts(), []);
  assert.equal(h.fake.requests.filter((q) => ['PUT', 'PATCH', 'DELETE'].includes(q.method)).length, 0);
  assert.equal(JSON.stringify(h.fake.db.apps), before);
});

test('an existing application with another agent key aborts; a grant that lacks the scope aborts', async (t) => {
  const h = await harness(t);
  await run(h);
  h.fake.db.apps[0].jwks = JSON.stringify({ keys: [{ kty: 'EC', kid: 'someone-else' }] });
  assert.match((await run(h)).stderr, /differs.*jwks/);
  const h2 = await harness(t);
  await run(h2);
  h2.fake.db.grants[0].scopes = [{ id: 'other-scope' }];
  const r = await run(h2);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /differs/);
});

test('state of another environment is refused', async (t) => {
  const h = await harness(t);
  await run(h);
  const other = '99999999-8888-4777-8666-555555555555';
  const r = await run(h, {}, { answers: { envId: other } });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /run teardown first/);
});

test('demo user (opt in): created in the default population, password printed once, never stored', async (t) => {
  const pops = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Other', default: false }, { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Default', default: true }];
  const h = await harness(t, { fake: { populations: pops } });
  const r = await run(h, { demoUser: true });
  assert.equal(r.exitCode, 0, r.stderr);
  const user = h.fake.db.users[0];
  assert.equal(h.fake.db.users.length, 1);
  assert.equal(user.username, 'poppy-demo');
  assert.match(user.email, /@demo\.example$/);
  assert.equal(user.population.id, pops[1].id);
  const password = h.fake.db.passwords.get(user.id);
  assert.ok(password && password.length >= 20);
  // printed exactly once, in stdout only
  assert.equal(r.stdout.split(password).length - 1, 1);
  assert.ok(!r.stderr.includes(password));
  assert.match(r.stdout, /poppy-demo\s+password: \S+/);
  // not in the state file, .env, any file, or any request other than the one password call
  for (const { file, text } of walk(h.cwd)) assert.ok(!text.includes(password), `${file} holds the password`);
  const holders = h.fake.requests.filter((q) => JSON.stringify(q).includes(password));
  assert.deepEqual(holders.map((q) => `${q.method} ${q.path.replace(/[0-9a-f-]{36}/g, ':id')}`), ['PUT /v1/environments/:id/users/:id/password']);
  assert.equal(holders[0].headers['content-type'], 'application/vnd.pingidentity.password.set+json');
  assert.equal(JSON.parse(holders[0].body).forceChange, false);
  assert.deepEqual(h.readState().objects.user, { id: user.id, username: 'poppy-demo', populationId: pops[1].id, created: true });
  assert.equal(h.fake.requests.some((q) => q.path.endsWith('/users') && q.method === 'POST' && /password/i.test(q.body)), false, 'the create call carries no password');

  // second run: no POST, no PUT, no password printed again
  h.fake.requests.length = 0;
  const again = await run(h, { demoUser: true });
  assert.equal(again.exitCode, 0, again.stderr);
  assert.deepEqual(h.fake.posts(), []);
  assert.equal(h.fake.requests.filter((q) => q.method === 'PUT').length, 0);
  assert.ok(!again.stdout.includes(password));
  assert.ok(!/password: /.test(again.stdout));
  assert.equal(h.readState().objects.user.created, true);
});

test('demo user: asked about when --demo-user is not passed, default no; yes creates it', async (t) => {
  const h = await harness(t);
  const no = await run(h);
  assert.equal(no.exitCode, 0);
  assert.equal(h.fake.db.users.length, 0);
  assert.ok(h.asked.some((q) => /demo user/i.test(q)));
  const h2 = await harness(t);
  const yes = await run(h2, {}, { answers: { demoUser: 'y' } });
  assert.equal(yes.exitCode, 0, yes.stderr);
  assert.equal(h2.fake.db.users.length, 1);
});

test('demo user: a failure setting the password leaves the user recorded for teardown and prints no password', async (t) => {
  const h = await harness(t);
  h.fake.failNext('PUT', /\/password$/, 400, { code: 'INVALID_VALUE', message: 'policy' });
  const r = await run(h, { demoUser: true });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /HTTP 400 INVALID_VALUE: policy/);
  const sent = JSON.parse(h.fake.requests.find((q) => q.method === 'PUT').body).value;
  assert.ok(!r.stdout.includes(sent) && !r.stderr.includes(sent));
  for (const { file, text } of walk(h.cwd)) assert.ok(!text.includes(sent), file);
  assert.equal(h.readState().objects.user.created, true);
});

test('demo user: an existing poppy-demo is adopted (created:false), its password untouched', async (t) => {
  const h = await harness(t);
  const pre = { id: 'bbbbbbbb-0000-4000-8000-000000000001', username: 'poppy-demo', population: { id: h.fake.db.populations[0].id } };
  h.fake.db.users.push(pre);
  const r = await run(h, { demoUser: true });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(h.fake.db.passwords.size, 0);
  assert.equal(h.readState().objects.user.created, false);
  assert.match(r.stdout, /not created by this tool/);
});

test('no prompt injected and no terminal: refuses with a plain message', async (t) => {
  const h = await harness(t);
  const m = h.make();
  const r = await runSetup({}, { ...m.deps, prompt: undefined });
  assert.equal(r.exitCode, 1);
  assert.match(m.stderr.text, /no prompt available/);
});

test('step 0 never fails the run: metadata that is missing or from another issuer only warns', async (t) => {
  const h = await harness(t, { fake: { openidIssuer: 'https://auth.pingone.example/other/as' } });
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /warning: the metadata issuer is https:\/\/auth\.pingone\.example\/other\/as/);
  const h2 = await harness(t);
  h2.fake.failNext('GET', /openid-configuration$/, 500, { code: 'X' });
  const r2 = await run(h2);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /step skipped/);
});

test('--env-file and --state-file override the default places', async (t) => {
  const h = await harness(t);
  const r = await run(h, { envFile: 'custom/.env.lab', stateFile: 'custom/state.json' });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(h.cwd, 'custom', '.env.lab')));
  assert.equal(mode(path.join(h.cwd, 'custom', 'state.json')), 0o600);
  assert.equal(fs.existsSync(h.envFile), false);
});

// ---- review findings (2026-11-17)

test('finding: a run that would resolve other objects than the ones this tool created is refused before it creates anything', async (t) => {
  const h = await harness(t);
  assert.equal((await run(h)).exitCode, 0);
  const before = JSON.stringify(h.readState().objects);
  h.fake.requests.length = 0;
  for (const opts of [{ name: 'Other App' }, { audience: 'https://other.example/x' }]) {
    const r = await run(h, opts);
    assert.equal(r.exitCode, 1, JSON.stringify(opts));
    assert.match(r.stderr, /run teardown first/);
    assert.deepEqual(h.fake.posts(), [], 'nothing was created, so nothing can be orphaned');
    assert.equal(JSON.stringify(h.readState().objects), before);
  }
  assert.equal(h.fake.db.apps.length, 1);
  assert.equal(h.fake.db.resources.length, 1);
  // The same names again are still an idempotent no-op.
  assert.equal((await run(h)).exitCode, 0);
  assert.deepEqual(h.fake.posts(), []);
});

test('finding: a worker in another environment: --worker-env-id mints the token there and manages the target environment', async (t) => {
  const WORKER_ENV = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const h = await harness(t, { fake: { workerEnvId: WORKER_ENV } });
  const without = await run(h);
  assert.equal(without.exitCode, 1);
  assert.match(without.stderr, /--worker-env-id/, 'the error says what to do');
  assert.equal(h.fake.db.resources.length, 0);
  const bad = await run(h, { workerEnvId: 'not-a-uuid' });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /not a UUID/);
  h.fake.requests.length = 0;
  const r = await run(h, { workerEnvId: WORKER_ENV });
  assert.equal(r.exitCode, 0, r.stderr);
  const tokenReq = h.fake.requests.find((q) => q.path.endsWith('/as/token'));
  assert.equal(tokenReq.path, `/${WORKER_ENV}/as/token`);
  assert.ok(h.fake.requests.filter((q) => q.path.startsWith('/v1/')).every((q) => q.path.startsWith(`/v1/environments/${h.fake.envId}/`)));
  assert.equal(h.fake.db.apps.length, 1);
  const state = h.readState();
  assert.equal(state.workerEnvironmentId, WORKER_ENV);
  assert.equal(state.environmentId, h.fake.envId);
  assert.equal(envLines(h).PAT_DEMO_P1_ISSUER, `https://auth.pingone.com/${h.fake.envId}/as`, 'the issuer is the target environment, not the worker one');
  assert.ok(!JSON.stringify([...walk(h.cwd)]).includes(TEST_SECRET));
});

test('finding: a demo password that failed to set is set (and shown once) on the rerun, not claimed as already shown', async (t) => {
  const h = await harness(t);
  h.fake.failNext('PUT', /\/password$/, 500, { code: 'UNEXPECTED', message: 'boom' });
  const first = await run(h, { demoUser: true });
  assert.equal(first.exitCode, 1);
  assert.equal(h.readState().objects.user.passwordPending, true);
  assert.equal(h.fake.db.passwords.size, 0);
  const again = await run(h, { demoUser: true });
  assert.equal(again.exitCode, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /was shown once and is not stored/);
  const user = h.fake.db.users[0];
  const password = h.fake.db.passwords.get(user.id);
  assert.ok(password, 'the password is set now');
  assert.equal(again.stdout.split(password).length - 1, 1, 'printed exactly once');
  assert.equal(h.fake.db.users.length, 1);
  assert.deepEqual(h.readState().objects.user, { id: user.id, username: 'poppy-demo', populationId: h.fake.db.populations[0].id, created: true });
  for (const { file, text } of walk(h.cwd)) assert.ok(!text.includes(password), file);
  // and a third run says the honest thing
  const third = await run(h, { demoUser: true });
  assert.match(third.stdout, /created by an earlier run; its password was shown once/);
  assert.ok(!third.stdout.includes(password));
});

test('finding: values that setup replaces in .env are put back by teardown, a rerun does not overwrite that memory', async (t) => {
  const h = await harness(t);
  const original = '# mine\nCOMPANY_AUDIENCE=https://mine.example/keep\nexport COMPANY_ISSUER = "https://issuer.mine.example"\nOTHER=1\n';
  fs.writeFileSync(h.envFile, original);
  assert.equal((await run(h)).exitCode, 0);
  const s1 = h.readState();
  assert.deepEqual(Object.keys(s1.envPrevious).sort(), ['COMPANY_AUDIENCE', 'COMPANY_ISSUER']);
  assert.equal(envLines(h).COMPANY_AUDIENCE, 'https://company.example/poppy');
  assert.equal((await run(h)).exitCode, 0);
  assert.deepEqual(h.readState().envPrevious, s1.envPrevious, 'the second run keeps what the first remembered');
  // a value the user edited in between is still theirs
  fs.writeFileSync(h.envFile, fs.readFileSync(h.envFile, 'utf8').replace('PAT_DEMO_P1_ISSUER=', 'PAT_DEMO_P1_ISSUER=edited-'));
  const { runTeardown } = await import('./teardown.mjs');
  const m = h.make();
  const t1 = await runTeardown({}, m.deps);
  assert.equal(t1.exitCode, 0, m.stderr.text);
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), `${original}PAT_DEMO_P1_ISSUER=edited-https://auth.pingone.com/${h.fake.envId}/as\n`);
});

test('finding: the demo password is scrubbed from an error even when PingOne echoes the request', async (t) => {
  const h = await harness(t);
  let sent = null;
  const echo = async (url, init) => {
    if (init?.method === 'PUT' && String(url).endsWith('/password')) {
      sent = JSON.parse(init.body).value;
      return new Response(JSON.stringify({ code: 'INVALID_VALUE', message: `bad request: ${init.body}` }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const r = await run(h, { demoUser: true }, { deps: { fetch: echo } });
  assert.equal(r.exitCode, 1);
  assert.ok(sent && sent.length >= 20);
  assert.ok(!r.stderr.includes(sent) && !r.stdout.includes(sent));
  assert.match(r.stderr, /\[redacted\]/);
});

test('finding: a POST whose response was lost is adopted as ours on the rerun, so teardown removes it', async (t) => {
  const h = await harness(t);
  let dropped = false;
  const lossy = async (url, init) => {
    const res = await fetch(url, init);
    if (!dropped && init?.method === 'POST' && String(url).endsWith('/applications')) { dropped = true; await res.text(); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
    return res;
  };
  const first = await run(h, {}, { deps: { fetch: lossy } });
  assert.equal(first.exitCode, 1);
  assert.equal(h.fake.db.apps.length, 1, 'the server did create it');
  assert.ok(!('application' in h.readState().objects));
  assert.deepEqual(h.readState().intents.application, { name: 'Poppy Agent Tester' });
  const again = await run(h);
  assert.equal(again.exitCode, 0, again.stderr);
  const state = h.readState();
  assert.equal(state.objects.application.created, true);
  assert.ok(!state.intents, 'intents are cleared once recorded');
  const { runTeardown } = await import('./teardown.mjs');
  const m = h.make();
  assert.equal((await runTeardown({}, m.deps)).exitCode, 0, m.stderr.text);
  assert.equal(h.fake.db.apps.length, 0);
});

test('finding: an object with the same name that someone else made after a definite refusal is not adopted as ours', async (t) => {
  const h = await harness(t);
  h.fake.failNext('POST', /\/applications$/, 400, { code: 'INVALID_DATA', message: 'nope' });
  assert.equal((await run(h)).exitCode, 1);
  assert.ok(!h.readState().intents?.application, 'a definite error is not a lost response');
});

test('finding: the resource name follows --name, and a foreign resource with the default name explains itself', async (t) => {
  const h = await harness(t);
  h.fake.db.resources.push({ id: '12345678-1234-4234-8234-123456789012', name: 'Poppy Company API reference', audience: 'https://foreign.example/api' });
  const clash = await run(h);
  assert.equal(clash.exitCode, 1);
  assert.match(clash.stderr, /UNIQUENESS_VIOLATION/);
  assert.match(clash.stderr, /--name/);
  const ok = await run(h, { name: 'Second Lab' });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(h.fake.db.resources.at(-1).name, 'Second Lab Company API reference');
});

test('finding: the application payload carries postLogoutRedirectUris (listed as Required in the docs)', async (t) => {
  const h = await harness(t);
  assert.equal((await run(h)).exitCode, 0);
  assert.deepEqual(h.fake.db.apps[0].postLogoutRedirectUris, [BASE]);
});

test('finding: values PingOne would hand back through .env are refused up front when --audience would be misread by Node', async (t) => {
  const h = await harness(t);
  const r = await run(h, { audience: 'https://c.example/a#b' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--audience/);
  assert.equal(h.fake.requests.length, 0);
});

test('finding: a spaced PAT_AGENT_BASE_URL = ... line is the user value, not overridden by an appended duplicate', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(h.envFile, 'PAT_AGENT_BASE_URL = http://127.0.0.1:5461\n');
  assert.equal((await run(h)).exitCode, 0);
  assert.equal(h.fake.db.apps[0].redirectUris[0], 'http://127.0.0.1:5461/cb');
  assert.equal(fs.readFileSync(h.envFile, 'utf8').split('\n').filter((l) => l.startsWith('PAT_AGENT_BASE_URL')).length, 1);
});
