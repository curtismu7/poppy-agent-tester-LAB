import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBindAllowed, bindHost, hostCheck, isLoopbackHost, portProblem, resolvePort, sameOriginWrites, PUBLIC_PATHS } from '../src/safety.js';

const run = (mw, req) => { const out = { status: 200, nexted: false }; mw(req, { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } }, () => { out.nexted = true; }); return out; };

test('loopback names are recognised, others are not', () => {
  for (const h of ['localhost', '127.0.0.1', '127.255.0.9', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '10.0.0.1', 'example.com', '127.0.0.1.evil.example', '128.0.0.1', '']) assert.equal(isLoopbackHost(h), false, h);
});

test('binding is loopback only unless PAT_BIND is set on purpose', () => {
  assert.equal(bindHost({}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { PAT_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.equal(assertBindAllowed('127.0.0.1', {}), '127.0.0.1');
});

test('ports: inside 5450-5499 and never a reserved one', () => {
  assert.equal(portProblem(5450), null);
  assert.equal(portProblem(5499), null);
  assert.match(portProblem(5449), /outside/);
  assert.match(portProblem(5500), /outside/);
  assert.match(portProblem(8080), /reserved/);
  assert.match(portProblem(4840), /reserved/);
  assert.match(portProblem(1.5), /not an integer/);
  assert.equal(resolvePort({}), 5450);
  assert.throws(() => resolvePort({ PORT: '8080' }));
  assert.throws(() => resolvePort({ PORT: 'abc' }));
});

test('hostCheck: loopback passes; a public agent name passes only for its three GET paths; everything else is refused', () => {
  const old = process.env.PAT_AGENT_HOST;
  try {
    delete process.env.PAT_AGENT_HOST;
    assert.equal(run(hostCheck, { headers: { host: 'localhost:5450' }, method: 'GET', originalUrl: '/api/state' }).nexted, true);
    assert.equal(run(hostCheck, { headers: { host: 'agent.example' }, method: 'GET', originalUrl: '/client.json' }).status, 403, 'not allowed while PAT_AGENT_HOST is unset');
    process.env.PAT_AGENT_HOST = 'Agent.Example';
    for (const p of PUBLIC_PATHS) assert.equal(run(hostCheck, { headers: { host: 'agent.example:5450' }, method: 'GET', originalUrl: `${p}?x=1` }).nexted, true, p);
    assert.equal(run(hostCheck, { headers: { host: 'agent.example' }, method: 'GET', originalUrl: '/api/state' }).body.error, 'public_host_scope');
    assert.equal(run(hostCheck, { headers: { host: 'agent.example' }, method: 'POST', originalUrl: '/cb' }).status, 403);
    assert.equal(run(hostCheck, { headers: { host: 'evil.example' }, method: 'GET', originalUrl: '/client.json' }).body.error, 'bad_host');
    assert.equal(run(hostCheck, { headers: {}, method: 'GET', originalUrl: '/' }).status, 403);
  } finally { if (old === undefined) delete process.env.PAT_AGENT_HOST; else process.env.PAT_AGENT_HOST = old; }
});

test('sameOriginWrites: reads pass; cross-site, same-site and foreign Origin writes are refused; none, same-origin and matching Origin pass', () => {
  const w = (headers) => run(sameOriginWrites, { method: 'POST', headers: { host: '127.0.0.1:5450', ...headers } });
  assert.equal(run(sameOriginWrites, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }).nexted, true);
  assert.equal(w({ 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(w({ 'sec-fetch-site': 'same-site' }).status, 403);
  assert.equal(w({ 'sec-fetch-site': 'none' }).nexted, true);
  assert.equal(w({ 'sec-fetch-site': 'same-origin' }).nexted, true);
  assert.equal(w({ origin: 'https://evil.example' }).status, 403);
  assert.equal(w({ origin: 'null' }).status, 403);
  assert.equal(w({ origin: 'http://127.0.0.1:5450' }).nexted, true);
  const old = process.env.PAT_PUBLIC_HOST;
  process.env.PAT_PUBLIC_HOST = 'public.example';
  try { assert.equal(w({ origin: 'https://public.example' }).nexted, true); } finally { if (old === undefined) delete process.env.PAT_PUBLIC_HOST; else process.env.PAT_PUBLIC_HOST = old; }
});
