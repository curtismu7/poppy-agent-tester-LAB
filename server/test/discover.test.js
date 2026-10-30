import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, parseOrigin, DiscoverError } from '../src/discover.js';

const ORIGIN = 'https://company.example';
const POPPY = { protocol_version: '0.3', auth: { issuer: 'https://pf.example:9031', scopes: { 'accounts:read': 'x' }, scope_hints: { 'accounts:read': { changes: 'none', personal_data: true } } } };
const RESOURCE = { resource: ORIGIN, authorization_servers: ['https://pf.example:9031'] };

const fake = (map) => async (url) => {
  const hit = map[url];
  if (!hit) return new Response('', { status: 404 });
  return typeof hit === 'function' ? hit() : new Response(JSON.stringify(hit), { status: 200 });
};

test('a good Company passes every check', async () => {
  const r = await discover(ORIGIN, { fetchImpl: fake({ [`${ORIGIN}/.well-known/poppy.json`]: POPPY, [`${ORIGIN}/.well-known/oauth-protected-resource`]: RESOURCE }) });
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 5);
});

test('a resource that is not exactly the origin fails the resource check, and a missing scope_hint fails its check', async () => {
  const bad = { ...POPPY, auth: { ...POPPY.auth, scope_hints: {} } };
  const r = await discover(ORIGIN, { fetchImpl: fake({ [`${ORIGIN}/.well-known/poppy.json`]: bad, [`${ORIGIN}/.well-known/oauth-protected-resource`]: { ...RESOURCE, resource: `${ORIGIN}/api` } }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id).sort(), ['resource', 'scope_hints']);
});

test('origins: https only, loopback http allowed, credentials and junk refused', () => {
  assert.equal(parseOrigin('https://company.example/anything?x=1'), ORIGIN);
  assert.equal(parseOrigin('http://localhost:3001'), 'http://localhost:3001');
  for (const bad of ['http://company.example', 'ftp://x.example', 'https://u:p@company.example', 'not a url', '', 'javascript:alert(1)']) {
    assert.throws(() => parseOrigin(bad), DiscoverError, bad);
  }
});

test('redirects are not followed, 404 and non-JSON are reported', async () => {
  await assert.rejects(discover(ORIGIN, { fetchImpl: fake({ [`${ORIGIN}/.well-known/poppy.json`]: () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }) }) }), { code: 'redirect' });
  await assert.rejects(discover(ORIGIN, { fetchImpl: fake({}) }), { code: 'http' });
  await assert.rejects(discover(ORIGIN, { fetchImpl: fake({ [`${ORIGIN}/.well-known/poppy.json`]: () => new Response('<html>', { status: 200 }) }) }), { code: 'not_json' });
});

test('an oversized document is refused', async () => {
  await assert.rejects(discover(ORIGIN, { fetchImpl: fake({ [`${ORIGIN}/.well-known/poppy.json`]: () => new Response('x'.repeat(300 * 1024), { status: 200 }) }) }), { code: 'too_large' });
});

test('only the typed origin is ever fetched', async () => {
  const seen = [];
  await discover(ORIGIN, { fetchImpl: async (u) => { seen.push(u); return new Response(JSON.stringify(u.endsWith('poppy.json') ? POPPY : RESOURCE), { status: 200 }); } });
  assert.deepEqual(seen, [`${ORIGIN}/.well-known/poppy.json`, `${ORIGIN}/.well-known/oauth-protected-resource`]);
});
