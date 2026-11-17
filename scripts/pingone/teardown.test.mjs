// node --test scripts/pingone/*.test.mjs
// Teardown against the in-process fake PingOne only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSetup } from './setup.mjs';
import { runTeardown } from './teardown.mjs';
import { createHarness, walk, TEST_SECRET } from './fakePingOne.mjs';

const harness = async (t, opts) => { const h = await createHarness(opts); t.after(() => h.close()); return h; };
const setup = async (h, opts = {}, over = {}) => { const m = h.make(over); const r = await runSetup(opts, m.deps); assert.equal(r.exitCode, 0, m.stderr.text); return m.stdout.text; };
const teardown = async (h, opts = {}, over = {}) => { const m = h.make(over); const r = await runTeardown(opts, m.deps); return { ...r, stdout: m.stdout.text, stderr: m.stderr.text }; };
const deletes = (h) => h.fake.requests.filter((q) => q.method === 'DELETE').map((q) => q.path.replace(`/v1/environments/${h.fake.envId}`, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'));
const empty = (h) => ['resources', 'scopes', 'apps', 'grants', 'users'].every((k) => h.fake.db[k].length === 0);

test('removes exactly what setup created, in order (user, grant, application, scope, resource), then the .env lines and the state file', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(h.envFile, '# mine\nANTHROPIC_API_KEY=sk-unrelated\nPAT_AGENT_BASE_URL=http://127.0.0.1:5450\n');
  await setup(h, { demoUser: true });
  assert.ok(h.fake.db.users.length === 1);
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(deletes(h), ['/users/:id', '/applications/:id/grants/:id', '/applications/:id', '/resources/:id/scopes/:id', '/resources/:id']);
  assert.ok(empty(h));
  assert.equal(fs.existsSync(h.stateFile), false);
  // the pre-existing PAT_AGENT_BASE_URL was not added by setup, so it stays; every owned line goes
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), '# mine\nANTHROPIC_API_KEY=sk-unrelated\nPAT_AGENT_BASE_URL=http://127.0.0.1:5450\n');
  assert.equal(fs.statSync(h.envFile).mode & 0o777, 0o600);
});

test('add-only lines that setup wrote are removed too, while their value still matches', async (t) => {
  const h = await harness(t);
  await setup(h);
  assert.match(fs.readFileSync(h.envFile, 'utf8'), /PAT_AGENT_BASE_URL=/);
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), '');
});

test('an .env line the user changed since setup is left alone', async (t) => {
  const h = await harness(t);
  await setup(h);
  const text = fs.readFileSync(h.envFile, 'utf8').replace(/^COMPANY_AUDIENCE=.*$/m, 'COMPANY_AUDIENCE=https://changed.example/aud').replace(/^PAT_AGENT_BASE_URL=.*$/m, 'PAT_AGENT_BASE_URL=http://127.0.0.1:5499');
  fs.writeFileSync(h.envFile, text);
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), 'COMPANY_AUDIENCE=https://changed.example/aud\nPAT_AGENT_BASE_URL=http://127.0.0.1:5499\n');
});

test('objects adopted with created:false are never deleted, and no worker credentials are asked for', async (t) => {
  const h = await harness(t);
  await setup(h);
  fs.rmSync(h.stateFile); // lose the state: the next setup adopts everything as created:false
  await setup(h, { demoUser: true });
  // the demo user is new in this run so it is ours; everything else was adopted
  const before = { resources: h.fake.db.resources.length, apps: h.fake.db.apps.length, scopes: h.fake.db.scopes.length, grants: h.fake.db.grants.length };
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(deletes(h), ['/users/:id']);
  assert.deepEqual({ resources: h.fake.db.resources.length, apps: h.fake.db.apps.length, scopes: h.fake.db.scopes.length, grants: h.fake.db.grants.length }, before);
  assert.match(r.stdout, /keeping application .* \(not created by this tool\)/);

  const h2 = await harness(t);
  await setup(h2);
  fs.rmSync(h2.stateFile);
  await setup(h2);
  const asked = h2.secretAsked.length;
  const r2 = await teardown(h2);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.equal(h2.secretAsked.length, asked, 'nothing to delete, so the secret is not requested');
  assert.deepEqual(deletes(h2), []);
  assert.equal(fs.existsSync(h2.stateFile), false);
  // the owned lines go; the add-only lines were already there when the second setup ran, so it never claimed them
  assert.equal(fs.readFileSync(h2.envFile, 'utf8'), 'PAT_AGENT_BASE_URL=http://127.0.0.1:5450\nPAT_DEMO_COMPANY_ORIGIN=http://127.0.0.1:5452\n');
});

test('a 404 on delete means already gone and is tolerated', async (t) => {
  const h = await harness(t);
  await setup(h);
  const appId = h.fake.db.apps[0].id;
  h.fake.db.apps = []; // deleted by someone else; its grants go with it
  h.fake.db.grants = [];
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /grant already gone/);
  assert.match(r.stdout, /application already gone/);
  assert.ok(h.fake.requests.some((q) => q.path.endsWith(`/applications/${appId}`) && q.method === 'DELETE'));
  assert.ok(empty(h));
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('an error mid-way is reported, the rest still runs, exit code is 1, the state file and .env lines are kept; a rerun finishes', async (t) => {
  const h = await harness(t);
  await setup(h);
  const envBefore = fs.readFileSync(h.envFile, 'utf8');
  h.fake.failNext('DELETE', /\/applications\/[^/]+$/, 500, { code: 'UNEXPECTED', message: 'boom' });
  const r = await teardown(h);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /could not delete application: HTTP 500 UNEXPECTED: boom/);
  assert.equal(h.fake.db.apps.length, 1, 'the failed delete left the application');
  assert.equal(h.fake.db.resources.length, 0, 'later steps still ran');
  assert.equal(h.fake.db.scopes.length, 0);
  assert.ok(fs.existsSync(h.stateFile));
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), envBefore);
  assert.match(r.stdout, /1 object\(s\) could not be removed/);

  const again = await teardown(h);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.ok(empty(h));
  assert.equal(fs.existsSync(h.stateFile), false);
  assert.equal(fs.readFileSync(h.envFile, 'utf8'), '');
});

test('after a setup that failed half way, teardown removes what was created', async (t) => {
  const h = await harness(t);
  h.fake.failNext('POST', /\/applications$/, 500, { code: 'UNEXPECTED', message: 'boom' });
  const m = h.make();
  assert.equal((await runSetup({}, m.deps)).exitCode, 1);
  assert.equal(h.fake.db.resources.length, 1);
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(empty(h));
  assert.equal(fs.existsSync(h.stateFile), false);
});

test('no state file: nothing to do, exit 0', async (t) => {
  const h = await harness(t);
  const r = await teardown(h);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /nothing to tear down/);
  assert.equal(h.fake.requests.length, 0);
});

test('the worker secret is asked again and appears nowhere; a wrong secret deletes nothing and keeps the state', async (t) => {
  const h = await harness(t);
  await setup(h);
  const before = h.secretAsked.length;
  const wrong = 'WRONG-SECRET-do-not-print-me';
  const bad = await teardown(h, {}, { answers: { secret: wrong } });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /worker credentials rejected/);
  assert.ok(!bad.stderr.includes(wrong) && !bad.stdout.includes(wrong));
  assert.deepEqual(deletes(h), []);
  assert.ok(fs.existsSync(h.stateFile));
  const ok = await teardown(h);
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(h.secretAsked.length, before + 2);
  assert.ok(!ok.stdout.includes(TEST_SECRET) && !ok.stderr.includes(TEST_SECRET));
  for (const { file, text } of walk(h.cwd)) assert.ok(!text.includes(TEST_SECRET), file);
  for (const q of h.fake.requests.filter((x) => !x.path.endsWith('/as/token'))) assert.ok(!JSON.stringify(q).includes(TEST_SECRET));
});

test('a tampered state file cannot steer the secret to another host or environment', async (t) => {
  const h = await harness(t);
  await setup(h);
  const state = h.readState();
  fs.writeFileSync(h.stateFile, JSON.stringify({ ...state, region: 'evil.invalid/x#' }));
  const r = await teardown(h);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /region in the state file/);
  assert.equal(h.secretAsked.length, 1, 'only setup asked for the secret');
  fs.writeFileSync(h.stateFile, JSON.stringify({ ...state, environmentId: 'not-a-uuid' }));
  assert.equal((await teardown(h)).exitCode, 1);
  fs.writeFileSync(h.stateFile, '{"schema":"x"}');
  assert.equal((await teardown(h)).exitCode, 1);
  assert.deepEqual(deletes(h), []);
});

test('--env-file and --state-file are honoured', async (t) => {
  const h = await harness(t);
  await setup(h, { envFile: 'c/.env.lab', stateFile: 'c/state.json' });
  assert.ok(fs.existsSync(h.file('c', 'state.json')));
  const r = await teardown(h, { envFile: 'c/.env.lab', stateFile: 'c/state.json' });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(fs.existsSync(h.file('c', 'state.json')), false);
  assert.equal(fs.readFileSync(h.file('c', '.env.lab'), 'utf8'), '');
  assert.ok(empty(h));
});

// ---- review findings (2026-11-17)

test('finding: ids in the state file are validated, so a tampered file cannot make the worker delete other objects', async (t) => {
  const h = await harness(t);
  await setup(h);
  const bystander = { id: '33333333-4444-4555-8666-777777777777', name: 'Bystander', redirectUris: ['http://127.0.0.1:1/cb'], jwks: '{}' };
  h.fake.db.apps.push(bystander);
  const good = h.readState();
  const evil = [
    { user: { id: `../applications/${bystander.id}`, created: true } },
    { user: { id: '../../../../v1/environments/99999999-2222-4333-8444-555555555555/users/x', created: true } },
    { grant: { id: `x/../../${bystander.id}`, created: true } },
    { application: { ...good.objects.application, id: `${good.objects.application.id}/../../applications/${bystander.id}` } },
    { scope: { ...good.objects.scope, id: '..%2f..%2fapplications' } },
    { resource: { ...good.objects.resource, id: 7 } },
  ];
  for (const objects of evil) {
    fs.writeFileSync(h.stateFile, JSON.stringify({ ...good, objects: { ...good.objects, ...objects } }));
    h.fake.requests.length = 0;
    const r = await teardown(h);
    assert.equal(r.exitCode, 1, JSON.stringify(objects));
    assert.match(r.stderr, /not a UUID/);
    assert.deepEqual(deletes(h), [], 'no DELETE was sent');
    assert.equal(h.secretAsked.length, 1, 'the worker secret was not even asked for');
    assert.ok(fs.existsSync(h.stateFile), 'the state file is kept');
  }
  assert.ok(h.fake.db.apps.some((a) => a.id === bystander.id), 'the bystander application is intact');
});

test('finding: env keys in the state file are never used as patterns, and foreign keys refuse the whole file', async (t) => {
  const h = await harness(t);
  await setup(h);
  fs.appendFileSync(h.envFile, 'DATABASE_URL=secretval\n');
  const good = h.readState();
  for (const env of [{ '[A-Z_]+': 'secretval' }, { '(a+)+$': 'x' }, { DATABASE_URL: 'secretval' }]) {
    fs.writeFileSync(h.stateFile, JSON.stringify({ ...good, env }));
    const started = Date.now();
    const r = await teardown(h);
    assert.ok(Date.now() - started < 5000);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /env key/);
    assert.match(fs.readFileSync(h.envFile, 'utf8'), /DATABASE_URL=secretval/);
  }
  assert.equal(h.fake.db.apps.length, 1, 'nothing was deleted');
});

test('finding: a worker from another environment: teardown mints there (from the state, or from the flag) and deletes in the target', async (t) => {
  const WORKER_ENV = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const h = await harness(t, { fake: { workerEnvId: WORKER_ENV } });
  await setup(h, { workerEnvId: WORKER_ENV });
  h.fake.requests.length = 0;
  const r = await teardown(h);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(h.fake.requests.find((q) => q.path.endsWith('/as/token')).path, `/${WORKER_ENV}/as/token`);
  assert.ok(empty(h));
  // an explicit flag wins over the state file (a state file from before the flag existed has none)
  const h2 = await harness(t, { fake: { workerEnvId: WORKER_ENV } });
  await setup(h2, { workerEnvId: WORKER_ENV });
  const s = h2.readState();
  delete s.workerEnvironmentId;
  fs.writeFileSync(h2.stateFile, JSON.stringify(s));
  assert.equal((await teardown(h2)).exitCode, 1, 'without the flag the token cannot be minted');
  assert.equal(h2.fake.db.apps.length, 1);
  const ok = await teardown(h2, { workerEnvId: WORKER_ENV });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.ok(empty(h2));
  assert.equal((await teardown(h2, { workerEnvId: 'nope' })).exitCode, 0, 'nothing left, so nothing to validate');
});
