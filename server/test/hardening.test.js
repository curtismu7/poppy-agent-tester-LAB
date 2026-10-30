import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { readCapped, readClipped, BodyTooLarge } from '../src/body.js';
import { createSessions, MAX_STEPS } from '../src/sessions.js';
import { modeFrom, hostedFrom } from '../src/config.js';
import { installNetguard, permitHost, clearPermitted } from '../src/netguard.js';
import { getJson, fetchIssuerMetadata, discover, DiscoverError } from '../src/discover.js';

const streamOf = (chunks) => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }));
const endless = () => { let pulled = 0; const res = new Response(new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(64 * 1024)); } })); return { res, pulled: () => pulled }; };

test('readCapped stops reading as soon as the cap is passed (it does not read an endless body)', async () => {
  const { res, pulled } = endless();
  await assert.rejects(readCapped(res, 100 * 1024), BodyTooLarge);
  assert.ok(pulled() < 10, `read only a few chunks, not the whole stream (${pulled()})`);
  assert.equal(await readCapped(streamOf(['ab', 'cd']), 10), 'abcd');
  await assert.rejects(readCapped(new Response('x'.repeat(50), { headers: { 'content-length': '50' } }), 10), BodyTooLarge);
  assert.match(await readClipped(streamOf(['x'.repeat(50)]), 10), /larger than 10 bytes/);
});

test('discovery and issuer metadata enforce the cap while reading', async () => {
  const { res } = endless();
  await assert.rejects(getJson('https://x.example/a', async () => res), { code: 'too_large' });
});

test('the hosted guard fails closed: any mode but live, and any PAT_HOSTED but 0/false/empty, is hosted', () => {
  assert.equal(hostedFrom({}), false);
  assert.equal(hostedFrom({ MODE: 'live' }), false);
  assert.equal(hostedFrom({ MODE: 'live', PAT_HOSTED: '0' }), false);
  assert.equal(hostedFrom({ MODE: 'live', PAT_HOSTED: 'false' }), false);
  for (const env of [{ MODE: '' }, { MODE: 'mock' }, { MODE: 'MOCK' }, { MODE: 'hosted' }, { MODE: 'Live' }, { PAT_HOSTED: '1' }, { PAT_HOSTED: 'true' }, { PAT_HOSTED: 'yes' }]) assert.equal(hostedFrom(env), true, JSON.stringify(env));
  assert.equal(modeFrom({ MODE: 'typo' }), 'mock');
});

test('sessions: TTL and max eviction, a bounded step log, and an unguessable session id', () => {
  let t = 1_000_000;
  const s = createSessions({ max: 2, ttlMs: 1000, now: () => t });
  const a = s.get('a'); s.get('b'); s.get('c');
  assert.equal(s.size(), 2, 'oldest evicted at max');
  assert.notEqual(s.get('a'), a, 'a was evicted, so it is a fresh record');
  t += 5000;
  s.get('z');
  assert.equal(s.size(), 1, 'everything older than the TTL is gone');
  for (let i = 0; i < MAX_STEPS + 10; i += 1) s.log('z', { kind: 'x', i });
  assert.equal(s.get('z').steps.length, MAX_STEPS);
  assert.equal(s.get('z').steps.at(-1).i, MAX_STEPS + 9, 'the newest steps are kept');
  const sids = new Set(Array.from({ length: 50 }, (_, i) => s.get(`s${i}`).sid));
  assert.equal(sids.size, 50);
  for (const sid of sids) assert.match(sid, /^sid-[A-Za-z0-9_-]{22}$/);
  s.reset('z');
  assert.notEqual(s.get('z').steps.length, MAX_STEPS);
});

test('netguard: a permit expires, is not shared with other hosts, and UDP connect and reverse lookup are blocked', async () => {
  const guard = installNetguard();
  try {
    permitHost('typed.invalid', Date.now() - 60_000); // already expired
    await assert.rejects(fetch('https://typed.invalid/'), /network blocked/);
    permitHost('typed.invalid');
    await assert.rejects(fetch('https://other.invalid/'), /network blocked/, 'a permit for one host opens no other');
    const s = dgram.createSocket('udp4');
    try { assert.throws(() => s.connect(9, ['192', '0', '2', '1'].join('.')), /network blocked/); } finally { s.close(); }
    await assert.rejects(dns.promises.lookupService(['192', '0', '2', '1'].join('.'), 80), /network blocked/);
    assert.ok(guard.attempts.some((a) => a.startsWith('udp:')) && guard.attempts.some((a) => a.startsWith('dns:')));
  } finally { guard.restore(); clearPermitted(); }
});

test('issuer metadata: RFC 8414 first, then OpenID discovery; a hostile or missing one is reported', async () => {
  const seen = [];
  const f = (map) => async (u) => { seen.push(u); const hit = map[u]; return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response('', { status: 404 }); };
  const iss = 'https://pf.example';
  const both = await fetchIssuerMetadata(iss, { fetchImpl: f({ [`${iss}/.well-known/oauth-authorization-server`]: { issuer: iss }, [`${iss}/.well-known/openid-configuration`]: { issuer: 'x' } }) });
  assert.equal(both.rfc8414, true);
  assert.equal(both.meta.issuer, iss);
  seen.length = 0;
  const fallback = await fetchIssuerMetadata(iss, { fetchImpl: f({ [`${iss}/.well-known/openid-configuration`]: { issuer: iss } }) });
  assert.equal(fallback.rfc8414, false);
  assert.equal(seen.length, 2);
  await assert.rejects(fetchIssuerMetadata(iss, { fetchImpl: f({}) }), DiscoverError);
});

test('discovery checks: version, domain, optional issuer, and a missing domain are judged as the spec says', async () => {
  const origin = 'https://company.example';
  const doc = (poppy, resource = { resource: origin, authorization_servers: ['https://pf.example'] }) => async (u) => new Response(JSON.stringify(u.endsWith('poppy.json') ? poppy : resource), { status: 200 });
  const base = { protocol_version: '0.3', organization: { domain: 'company.example' }, auth: { issuer: 'https://pf.example', scopes: { 'a:r': 'x' }, scope_hints: { 'a:r': { changes: 'none', personal_data: true } } } };
  const ok = async (poppy, resource) => (await discover(origin, { fetchImpl: doc(poppy, resource) }));
  assert.equal((await ok(base)).ok, true);
  assert.equal((await ok({ ...base, protocol_version: '9.9' })).checks.find((c) => c.id === 'version').ok, false);
  assert.equal((await ok({ ...base, protocol_version: '0.4' })).checks.find((c) => c.id === 'version').ok, false);
  assert.equal((await ok({ ...base, organization: { domain: 'someone-else.example' } })).checks.find((c) => c.id === 'domain').ok, false);
  assert.equal((await ok({ ...base, organization: undefined })).checks.find((c) => c.id === 'domain').ok, false);
  assert.equal((await ok({ ...base, organization: { domain: 'COMPANY.example' } })).checks.find((c) => c.id === 'domain').ok, true, 'case-insensitive');
  // auth.issuer is optional when the protected-resource document lists exactly one server
  const noIssuer = await ok({ ...base, auth: { ...base.auth, issuer: undefined } });
  assert.equal(noIssuer.issuer, 'https://pf.example');
  assert.equal(noIssuer.ok, true);
  const two = await ok({ ...base, auth: { ...base.auth, issuer: undefined } }, { resource: origin, authorization_servers: ['https://a.example', 'https://b.example'] });
  assert.equal(two.checks.find((c) => c.id === 'issuer').ok, false);
});
