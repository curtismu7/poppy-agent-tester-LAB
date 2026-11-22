// Rule 27: the run-observability record this lab builds, and the stdout lines its server writes.
// Mock: the example run's own signings (simulated). Real: the replies the lab received (response) plus lines read from an in-process
// fake loopback Elasticsearch (logged). Every record passes the shared assertRunObservability contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createSessions } from '../src/sessions.js';
import { createHealth } from '../src/health.js';
import { generateEs256Key, jwkThumbprint } from '../src/jose.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { ElasticsearchReader } from '../src/runObservabilityReaders.js';
import { MAX_EVENTS, addEvent, buildRealRecord, currentRun, decisionLine, freshObs, lineValue, replyOutcome, startRun } from '../src/runObs.js';
import { sampleEvents } from '../src/sample.js';

const CO = 'https://company.example';
const ISS = 'https://pf.example:9031';
const BASE = 'https://agent.example';
const PRODUCTS = [...new Set(layerMatchers.map((m) => m.product))];
// <iso> poppy-agent-tester step=<id> layer=<layer> actor=<who> result=<word> mode=<mode>
const LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z poppy-agent-tester step=[A-Za-z0-9._:/@-]+ layer=[A-Za-z0-9._:/@-]+ actor=[A-Za-z0-9._:/@-]+ result=(passed|stopped|unclear|no-reply) mode=(mock|real)$/;
const ESKEY = ['read', 'only', 'test', 'value'].join('-'); // built from parts so no scanner reads it as a credential
const k = generateEs256Key();
const agent = { privateKey: k.privateKey, publicJwk: k.publicJwk, kid: jwkThumbprint(k.publicJwk) };
const closers = [];
after(() => { for (const c of closers) c(); });

const jsonRes = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A fake Company and a fake issuer behind the lab's fetch. `cfg` changes what they answer.
function makeFetch(cfg = {}) {
  const seen = { par: [], tokenForms: 0, calls: 0 };
  const meta = () => ({ issuer: ISS, authorization_endpoint: `${ISS}/as/authorization.oauth2`, token_endpoint: `${ISS}/as/token.oauth2`, pushed_authorization_request_endpoint: `${ISS}/as/par.oauth2`, authorization_response_iss_parameter_supported: cfg.issRequired === true });
  const claims = cfg.claims ?? { client_id: `${BASE}/client.json`, scope: 'accounts:read', sub: 'person-1' };
  const access = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === CO) {
      if (u.pathname === '/.well-known/poppy.json') return jsonRes(200, { protocol_version: '1.0', organization: { domain: u.host }, auth: { issuer: ISS, scopes: { 'accounts:read': 'Read accounts' }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } } });
      if (u.pathname === '/.well-known/oauth-protected-resource') return jsonRes(200, { resource: CO, authorization_servers: [ISS] });
      seen.calls += 1;
      return jsonRes(cfg.callStatus ?? 200, cfg.callBody ?? { user_id: 'person-1' });
    }
    if (u.origin === ISS) {
      if (u.pathname.startsWith('/.well-known/')) return jsonRes(200, meta());
      if (u.pathname === '/as/par.oauth2') { seen.par.push(String(init.body)); return cfg.parStatus && cfg.parStatus !== 201 ? jsonRes(cfg.parStatus, { error: 'invalid_client' }) : jsonRes(201, { request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 60 }); }
      if (u.pathname === '/as/token.oauth2') { seen.tokenForms += 1; return cfg.tokenStatus && cfg.tokenStatus !== 200 ? jsonRes(cfg.tokenStatus, { error: 'invalid_grant' }) : jsonRes(200, { access_token: access, token_type: 'Bearer', expires_in: 60, scope: 'accounts:read' }); }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { f, seen };
}

// An app on a loopback port; `lines` collects the stdout lines it writes.
async function boot({ hosted = false, cfg = {}, extra = {} } = {}) {
  const lines = [];
  const { f, seen } = makeFetch(cfg);
  const app = createApp({ agent, baseUrl: BASE, hosted, sessions: createSessions(), health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }), fetchImpl: f, log: (l) => lines.push(l), ...extra });
  const server = await new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, ws = 'w1') => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* a redirect has no body */ }
    return { status: r.status, body: parsed, text, headers: r.headers };
  };
  const stateOf = () => new URLSearchParams(seen.par.at(-1)).get('state');
  const rec = async (ws = 'w1') => (await call('GET', '/api/run-observability', undefined, ws)).body;
  // The steps the page takes.
  const step1 = (ws) => call('POST', '/api/discover', { origin: CO, issuer: ISS }, ws);
  const step2 = (ws) => call('POST', '/api/authorize', { scope: 'accounts:read', from: 'run' }, ws);
  const back = (query, ws) => call('GET', `/cb?${new URLSearchParams(query)}`, undefined, ws);
  const step3 = (ws) => call('POST', '/api/call', {}, ws);
  const signedIn = async (ws) => { await step1(ws); await step2(ws); return back({ code: 'C1', state: stateOf(), iss: ISS }, ws); };
  return { call, rec, lines, seen, base, stateOf, step1, step2, step3, back, signedIn };
}
const rows = (r, layer) => r.rows.filter((x) => x.layer === layer && x.origin !== 'not-logged');
const classifyAll = (line) => PRODUCTS.filter((product) => classify({ product, message: line }) !== null);

// ---- Mock ------------------------------------------------------------------------------------------------------------------------
test('Mock: the record holds only the three signings the example builder did, all simulated, and assertRunObservability passes', async () => {
  const lab = await boot({ hosted: true });
  const r = (await lab.rec()).record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.source, 'mock');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.coverage, { person: 'not-logged', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'not-logged', resource: 'not-logged' });
  assert.ok(r.rows.every((x) => x.origin === 'simulated' || x.origin === 'not-logged'), 'nothing is shown as read from a log or as a reply');
  assert.deepEqual(rows(r, 'agent').map((x) => x.message.split(' ').slice(0, 6).join(' ')), ['The mock agent signed a delegation', 'The mock agent signed a Poppy-Session', 'The mock agent signed its client']);
  assert.deepEqual(r.summary, { allowed: 0, refused: 0, blocked: 0, info: 3, unverified: 0 }, 'a signing is information, never a permit');
  for (const layer of ['person', 'authorize', 'privilege', 'gateway', 'resource']) assert.ok(r.reasons[layer], `${layer} says why it is not logged`);
  assert.match(r.reasons.person, /nobody in/);
  assert.match(r.reasons.resource, /contacts no Company/);
});

test('Mock: each row time is the time of the stdout line for the same event, in the order the builder did them', async () => {
  const lab = await boot({ hosted: true });
  await lab.rec(); // the first request builds the example and writes its lines
  const r = (await lab.rec()).record;
  assert.equal(lab.lines.length, 3, 'written once, not once per request');
  const stamps = lab.lines.map((l) => l.split(' ')[0]);
  assert.deepEqual(rows(r, 'agent').map((x) => x.atExact), stamps);
  assert.deepEqual(stamps, sampleEvents().map((e) => e.at));
  assert.deepEqual(stamps, [...stamps].sort());
  assert.deepEqual(lab.lines.map((l) => l.match(/step=(\S+)/)[1]), ['example-delegation', 'example-session', 'example-agent-auth']);
});

test('Mock: no correlation id is declared, so names stay readable (an undeclared 32-hex id would show as <id>)', async () => {
  const lab = await boot({ hosted: true });
  const text = JSON.stringify((await lab.rec()).record.rows);
  assert.match(text, /Poppy-Session/);
  assert.ok(!/…|<id>/.test(text));
});

test('the mode switches both ways at runtime and the record follows it; GET /api/info is unchanged by observability', async () => {
  const lab = await boot({ hosted: true });
  assert.equal((await lab.rec()).record.source, 'mock');
  assert.equal((await lab.call('POST', '/api/mode', { source: 'real' })).status, 200);
  const none = await lab.rec();
  assert.equal(none.record, null, 'Real has no run yet: no record, not the example');
  assert.match(none.message, /No run yet/);
  await lab.step1();
  assert.equal((await lab.rec()).record.source, 'real');
  assert.equal((await lab.call('POST', '/api/mode', { source: 'mock' })).status, 200);
  assert.equal((await lab.rec()).record.source, 'mock');
  const info = (await lab.call('GET', '/api/info')).body;
  assert.equal(info.source, 'mock');
  assert.equal(info.realAvailable, true);
  assert.deepEqual(Object.keys(info).sort(), ['agentClientId', 'chatAgent', 'configured', 'defaults', 'hosted', 'realAvailable', 'realReason', 'registered', 'simulated', 'source']);
});

test('the record route answers JSON errors: bad workspace is 400 {error, message}', async () => {
  const lab = await boot({ hosted: true });
  const r = await lab.call('GET', '/api/run-observability', undefined, 'Bad Workspace!');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_workspace');
  assert.ok(r.body.message);
});

// ---- Real: replies the lab received -----------------------------------------------------------------------------------------------
test('Real, a permitted run: response rows for the replies received (never logged), correct layers, one run', async () => {
  const lab = await boot();
  assert.equal((await lab.signedIn()).status, 302);
  assert.equal((await lab.step3()).status, 200);
  const r = (await lab.rec()).record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.source, 'real');
  assert.ok(r.rows.every((x) => x.origin === 'response' || x.origin === 'not-logged'), 'no logged row without a log reader, no simulated row in Real');
  assert.deepEqual(r.rows.filter((x) => x.origin === 'response').map((x) => `${x.layer}|${x.outcome}`), ['resource|info', 'agent|allowed', 'person|allowed', 'resource|allowed']);
  assert.deepEqual(r.coverage, { person: 'response', agent: 'response', authorize: 'not-logged', privilege: 'not-logged', gateway: 'not-logged', resource: 'response' });
  assert.deepEqual(r.summary, { allowed: 3, refused: 0, blocked: 0, info: 1, unverified: 0 });
  // No log reader is configured here: the log layers say what to set; the response rows stay.
  assert.match(r.reasons.person, /RUN_OBS_ES_URL/);
  assert.equal(r.truncated, false);
  const times = r.rows.filter((x) => x.at).map((x) => x.atExact);
  assert.deepEqual(times, lab.lines.map((l) => l.split(' ')[0]), 'each row time is the time of its stdout line');
});

test('Real, a refused sign-in: the issuer turned the code exchange down, and nothing after it is invented', async () => {
  const lab = await boot({ cfg: { tokenStatus: 400 } });
  assert.equal((await lab.signedIn()).headers.get('location').includes('signin=error'), true);
  assert.equal((await lab.step3()).status, 409);
  const r = (await lab.rec()).record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.deepEqual(rows(r, 'person').map((x) => x.outcome), ['refused']);
  assert.deepEqual(rows(r, 'resource').map((x) => x.message.slice(0, 22)), ['The Company answered w'], 'only the documents reply: no Company call ran');
  assert.deepEqual(r.summary, { allowed: 1, refused: 1, blocked: 0, info: 1, unverified: 0 });
  assert.ok(lab.lines.some((l) => /step=code-exchange .* result=stopped/.test(l)));
});

test('Real, the issuer refuses the pushed request: an agent row, refused', async () => {
  const lab = await boot({ cfg: { parStatus: 400 } });
  await lab.step1();
  assert.equal((await lab.step2()).status, 502);
  const r = (await lab.rec()).record;
  assert.deepEqual(rows(r, 'agent').map((x) => x.outcome), ['refused']);
  assert.match(rows(r, 'agent')[0].message, /turned down/);
});

test('Real, a Company that turns the call down (403) is refused; a 200 with no JSON body is information, never a permit', async () => {
  const denied = await boot({ cfg: { callStatus: 403, callBody: { error: 'forbidden' } } });
  await denied.signedIn(); await denied.step3();
  const a = (await denied.rec()).record;
  assert.deepEqual(rows(a, 'resource').map((x) => x.outcome), ['info', 'refused']);
  const odd = await boot({ cfg: { callStatus: 200, callBody: 'plain text, not JSON' } });
  await odd.signedIn(); await odd.step3();
  const b = (await odd.rec()).record;
  assert.deepEqual(rows(b, 'resource').map((x) => x.outcome), ['info', 'info']);
  assert.deepEqual(assertRunObservability(a), []);
  assert.deepEqual(assertRunObservability(b), []);
});

test('Real, a redirect that carries the wrong issuer: the lab stopped the sign-in, shown as information; an issuer error is a refusal', async () => {
  const lab = await boot();
  await lab.step1(); await lab.step2();
  await lab.back({ code: 'C1', state: lab.stateOf(), iss: 'https://other.example' });
  let r = (await lab.rec()).record;
  assert.deepEqual(rows(r, 'person').map((x) => `${x.outcome}`), ['info']);
  assert.match(rows(r, 'person')[0].message, /stopped the sign-in/);
  assert.equal(lab.seen.tokenForms, 0, 'no code exchange ran');
  await lab.step2();
  await lab.back({ error: 'access_denied', state: lab.stateOf(), iss: ISS });
  r = (await lab.rec()).record;
  assert.deepEqual(rows(r, 'person').map((x) => x.outcome), ['info', 'refused']);
  assert.deepEqual(assertRunObservability(r), []);
});

test('one run per record: a new read starts a new run, a late reply of the old one and calls after the verdict join nothing', async () => {
  const lab = await boot();
  await lab.signedIn();
  assert.equal((await lab.step3()).status, 200);
  const first = (await lab.rec()).record;
  assert.equal(rows(first, 'resource').length, 2);
  // A second call after the final verdict joins no record.
  assert.equal((await lab.step3()).status, 200);
  assert.equal(rows((await lab.rec()).record, 'resource').length, 2);
  // A sign-in started in run 1, then run 2 starts; run 1's late redirect belongs to run 1, not to run 2.
  await lab.step1(); await lab.step2();
  const stale = lab.stateOf();
  await lab.step1();
  await lab.back({ code: 'C1', state: stale, iss: ISS });
  const r = (await lab.rec()).record;
  assert.deepEqual(r.rows.filter((x) => x.origin === 'response').map((x) => `${x.layer}|${x.outcome}`), ['resource|info'], 'run 3 holds only its own documents reply');
  // The token that late redirect produced came from another run: a call now joins no record either.
  assert.equal((await lab.step3()).status, 200);
  assert.equal(rows((await lab.rec()).record, 'resource').length, 1);
});

test('the events list is bounded, and the current run keeps the event that started it', () => {
  const obs = freshObs();
  for (let i = 0; i < 3; i += 1) { const runId = startRun(obs, { id: 'c', kind: 'cimd' }); addEvent(obs, { runId, step: 'read-company', layer: 'resource' }); }
  const runId = obs.open;
  for (let i = 0; i < MAX_EVENTS + 20; i += 1) addEvent(obs, { runId, step: 'push-request', layer: 'agent', n: i });
  assert.equal(obs.events.length, MAX_EVENTS);
  const run = currentRun(obs);
  assert.equal(run[0].step, 'read-company', 'the starting event is never evicted');
  assert.ok(run.every((e) => e.runId === runId), 'older runs went first');
  assert.equal(addEvent(obs, { runId: null, step: 'call-company' }).step, 'call-company');
  assert.equal(obs.events.length, MAX_EVENTS, 'an event outside a run is kept in no record');
});

test('replyOutcome: only a usable 2xx is allowed; 401/403 (and 400 at an OAuth endpoint) are refusals; anything else is information', () => {
  assert.equal(replyOutcome(200, { usable: true }), 'allowed');
  assert.equal(replyOutcome(200, { usable: false }), 'info');
  assert.equal(replyOutcome(403, { usable: true }), 'refused');
  assert.equal(replyOutcome(400, { usable: false }), 'info');
  assert.equal(replyOutcome(400, { usable: false, oauth: true }), 'refused');
  assert.equal(replyOutcome(500, { usable: false, oauth: true }), 'info');
});

// ---- Real: the products' logs from a fake loopback Elasticsearch ------------------------------------------------------------------------
const AUDIT = (subject) => `/opt/out/instance/log/audit.log: 2026-11-22T10:00:03.250Z| tid:t1| trk1| AUTHN_ATTEMPT| ${subject}| | | client-1| OAuth20| | IdP| failure| | the sign-in did not complete| 12`;
async function fakeEs({ status = 200, lines = [] } = {}) {
  const seen = { auth: [], bodies: [] };
  const server = await new Promise((res) => { const s = http.createServer((q, r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    seen.auth.push(q.headers.authorization); const body = JSON.parse(b || '{}'); seen.bodies.push(body);
    // The product's lines carry a time inside the run's window; the window's own end is always inside it, however fast the test ran.
    const lte = Date.parse(body.query.bool.filter[0].range['@timestamp'].lte);
    r.writeHead(status, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ hits: { hits: lines.map((message) => ({ _source: { '@timestamp': new Date(lte).toISOString(), message } })) } }));
  }); }).listen(0, '127.0.0.1', () => res(s)); });
  closers.push(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('Real with Elasticsearch: a PingFederate audit line is a logged row next to the response rows, and the key is never in the record', async () => {
  const es = await fakeEs({ lines: [AUDIT(''), AUDIT('person-1')] });
  const lab = await boot({ extra: { runObsReaders: [new ElasticsearchReader({ url: es.url, apiKey: ESKEY })] } });
  await lab.signedIn(); await lab.step3();
  const res = await lab.call('GET', '/api/run-observability');
  const r = res.body.record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.coverage.person, 'logged');
  assert.equal(r.coverage.agent, 'logged');
  assert.deepEqual(r.rows.filter((x) => x.origin === 'logged').map((x) => `${x.layer}|${x.outcome}|${x.product}`).sort(), ['agent|refused|pingfederate', 'person|refused|pingfederate']);
  assert.ok(r.rows.filter((x) => x.origin === 'response').length >= 3, 'the replies the lab received are still response rows');
  assert.ok(es.seen.auth.every((a) => a === `ApiKey ${ESKEY}`));
  assert.ok(es.seen.bodies.every((b) => JSON.stringify(b).includes('pingfederate')));
  assert.ok(!res.text.includes(ESKEY), 'the read key is never returned');
  assert.equal(r.coverage.resource, 'response', 'the Company is not a product this lab reads');
});

test('Real with Elasticsearch refusing the key: the log layers say unreachable-or-response with the reason, the key is not in it, the lab keeps working', async () => {
  const es = await fakeEs({ status: 401 });
  const lab = await boot({ extra: { runObsReaders: [new ElasticsearchReader({ url: es.url, apiKey: ESKEY })] } });
  await lab.signedIn();
  const res = await lab.call('GET', '/api/run-observability');
  assert.equal(res.status, 200);
  assert.deepEqual(assertRunObservability(res.body.record), []);
  assert.match(res.body.record.reasons.person, /refused the read credential/);
  assert.ok(!res.text.includes(ESKEY));
});

test('Real with a PingOne (registered) client: the issuer log is not read, and the layer says why', async () => {
  const lab = await boot({ extra: { registered: { clientId: 'app-1', issuer: ISS, assertionAud: 'endpoint', assertionTyp: 'JWT' } } });
  await lab.step1();
  const r = (await lab.rec()).record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.coverage.person, 'not-logged');
  assert.match(r.reasons.person, /PingOne audit activity API/);
  assert.equal(r.coverage.agent, 'not-logged');
});

test('buildRealRecord with an inline fake reader: a logged row is only what the reader returned; a reader that returns nothing leaves not-logged', async () => {
  const events = [{ at: '2026-11-22T10:00:00.000Z', layer: 'resource', outcome: 'info', product: 'Company reply', message: 'The Company answered with its documents.' }];
  const silent = { name: 'fake', canRead: () => true, readLines: async () => ({ lines: [] }) };
  const r = await buildRealRecord({ events, registered: false, readers: [silent], clock: () => Date.parse('2026-11-22T10:00:05.000Z') });
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.coverage.person, 'not-logged');
  assert.ok(!r.rows.some((x) => x.origin === 'logged'));
  const loud = { name: 'fake', canRead: () => true, readLines: async () => ({ lines: [{ product: 'pingfederate', at: Date.parse('2026-11-22T10:00:02.000Z'), atExact: '2026-11-22T10:00:02.000Z', message: AUDIT('person-1') }] }) };
  const l = await buildRealRecord({ events, registered: false, readers: [loud], clock: () => Date.parse('2026-11-22T10:00:05.000Z') });
  assert.deepEqual(assertRunObservability(l), []);
  assert.equal(l.coverage.person, 'logged');
  assert.deepEqual(l.rows.filter((x) => x.origin === 'logged').map((x) => x.layer), ['person']);
});

test('a record built with declared ids in the detail is not marked truncated, and declared ids are shortened', async () => {
  const events = [{ at: '2026-11-22T10:00:00.000Z', layer: 'resource', outcome: 'info', product: 'Company reply', message: 'Reply for user-with-a-long-name.', detail: { sub: 'user-with-a-long-name', client: 'https://agent.example/client.json' } }];
  const silent = { name: 'fake', canRead: () => true, readLines: async () => ({ lines: [] }) };
  const r = await buildRealRecord({ events, registered: false, who: { sub: 'user-with-a-long-name', actor: 'https://agent.example/client.json', traceId: '0af7651916cd43dd8448eb211c80319c' }, readers: [silent], clock: () => Date.parse('2026-11-22T10:00:05.000Z') });
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.truncated, false);
  assert.ok(!JSON.stringify(r.rows).includes('user-with-a-long-name'), 'a declared id is shortened to its first 4 and last 2 characters');
  assert.match(JSON.stringify(r.rows), /user…me/);
});

// ---- The lab's own stdout lines -------------------------------------------------------------------------------------------------------
test('a hostile value cannot add a second key=value pair or a second line to a stdout line', () => {
  const line = decisionLine({ at: '2026-11-22T10:00:00.000Z', source: 'real', step: 'call-company', layer: 'resource', actor: 'x result=passed\nforged=1 "a"', outcome: 'refused' });
  assert.ok(!/\n/.test(line));
  assert.equal(line.match(/ result=/g).length, 1);
  assert.match(line, LINE);
  assert.ok(!/[\s=]/.test(lineValue('a b\r\nc=d')));
  assert.equal(lineValue(''), 'unknown');
});

test('a hostile redirect error (new lines, a fake pair) is one line, one pair, and the row message is plain text', async () => {
  const lab = await boot();
  await lab.step1(); await lab.step2();
  await lab.back({ error: 'x\nresult=passed forged=1 <img src=x onerror=1>', state: lab.stateOf(), iss: ISS });
  assert.ok(lab.lines.every((l) => LINE.test(l)), lab.lines.join('\n'));
  const r = (await lab.rec()).record;
  assert.deepEqual(assertRunObservability(r), []);
  assert.ok(!/[\r\n]/.test(rows(r, 'person')[0].message));
  assert.ok(!/ forged=1/.test(lab.lines.join('\n')));
});

test('no stdout line, on any path (permitted, refused, stopped, no reply, Mock), is read as a decision by any shared matcher', async () => {
  const all = [];
  for (const cfg of [{}, { tokenStatus: 400 }, { parStatus: 400 }, { callStatus: 403 }, { callStatus: 200, callBody: 'text' }, { callStatus: 500 }]) {
    const lab = await boot({ cfg });
    await lab.signedIn(); await lab.step3();
    all.push(...lab.lines);
  }
  const wrong = await boot();
  await wrong.step1(); await wrong.step2();
  await wrong.back({ code: 'C1', state: wrong.stateOf(), iss: 'https://other.example' });
  await wrong.step2();
  await wrong.back({ error: 'access_denied', state: wrong.stateOf(), iss: ISS });
  all.push(...wrong.lines);
  const mock = await boot({ hosted: true });
  await mock.rec();
  all.push(...mock.lines);
  assert.ok(all.length > 20);
  assert.ok(all.some((l) => /result=stopped/.test(l)) && all.some((l) => /result=passed/.test(l)) && all.some((l) => /result=unclear/.test(l)));
  for (const l of all) {
    assert.match(l, LINE);
    assert.deepEqual(classifyAll(l), [], l);
    assert.ok(!/refused|denied|forbidden|unauthori[sz]ed|insufficient|invalid|failed|expired|mismatch|rejected|not allowed|token|audience|scope|served|introspect/i.test(l), l);
  }
  // The matchers are anchored, not switched off: a real MCP-server header line still classifies.
  assert.equal(classify({ product: 'mcp-server', message: '[2026-11-22T10:00:06.000Z] INFO: token audience validated' })?.layer, 'resource');
});

test('the Docker socket is never mounted or enabled, and the only readers code is the vendored file plus the one call that picks them', async () => {
  const fs = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const text = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  assert.ok(!/docker\.sock/.test(text('docker-compose.yml')));
  assert.ok(!/RUN_OBS_DOCKER|RUN_OBS_CONTAINERS|RUN_OBS_LOG_FILES/.test(text('docker-compose.yml')));
  assert.ok(!/^\s*#?\s*RUN_OBS_(DOCKER|CONTAINERS|LOG_FILES)=/m.test(text('.env.example')), 'the Docker reader is never switched on, not even as a commented example');
  assert.match(text('docker-compose.yml'), /RUN_OBS_ES_URL: \$\{RUN_OBS_ES_URL:-\}/);
  assert.match(text('docker-compose.yml'), /RUN_OBS_ES_READ_APIKEY: \$\{RUN_OBS_ES_READ_APIKEY:-\}/);
  assert.match(text('.env.example'), /^# RUN_OBS_ES_URL=$/m);
  const src = fs.readdirSync(new URL('server/src/', root)).filter((f) => f.endsWith('.js') && f !== 'runObservabilityReaders.js');
  const mentions = src.filter((f) => /readersFromEnv|DockerLogReader|ElasticsearchReader|socketPath/.test(text(`server/src/${f}`)));
  assert.deepEqual(mentions, ['runObs.js'], 'only the one place that picks the readers (readersFromEnv); the core names no reader, not even in a comment');
  assert.match(text('server/src/netguard.js'), /run-observability Elasticsearch reader/);
});
