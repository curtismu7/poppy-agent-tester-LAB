import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createKeyStore, KeyFetchError, MAX_JWKS_BYTES } from '../src/keys.js';
import { decodeJws, jwkThumbprint, verifyEs256, verifyRs256, verifyPs384, isPublicEcP256Jwk } from '../src/jws.js';
import { genEc, genRsa, signEs256, signRs256, signPs384, json, routedFetch, clock, thumb, tamper } from './helpers.js';

const URI = 'https://keys.example/jwks';
const ec = genEc();
const ecKey = (kid, k = ec) => ({ ...k.publicJwk, kid, alg: 'ES256', use: 'sig' });
const store = (routes, over = {}) => {
  const clk = clock();
  const fetchImpl = typeof routes === 'function' ? (() => { const f = async (url, init) => { f.calls.push({ url: String(url), init }); return routes(init); }; f.calls = []; return f; })() : routedFetch({ [URI]: routes });
  return { clk, fetchImpl, s: createKeyStore({ uri: URI, kind: 'agent', fetchImpl, now: clk.now, ...over }) };
};
const rejectsKeyFetch = (p, re) => assert.rejects(p, (e) => e instanceof KeyFetchError && re.test(e.message));

test('serves a key by kid and caches the document for 300 s', async () => {
  const { s, fetchImpl, clk } = store(() => json({ keys: [ecKey('a')] }));
  assert.equal((await s.getKey('a')).x, ec.publicJwk.x);
  await s.getKey('a');
  assert.equal(fetchImpl.calls.length, 1);
  clk.advance(299);
  await s.getKey('a');
  assert.equal(fetchImpl.calls.length, 1);
  clk.advance(2);
  await s.getKey('a');
  assert.equal(fetchImpl.calls.length, 2);
});

test('fetch options: no redirects, a timeout signal, https only', async () => {
  const { s, fetchImpl } = store(() => json({ keys: [ecKey('a')] }));
  await s.getKey('a');
  const init = fetchImpl.calls[0].init;
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
});

test('an unknown kid forces one refetch, at most once per 30 s', async () => {
  const docs = [{ keys: [ecKey('a')] }, { keys: [ecKey('a'), ecKey('b')] }];
  let n = 0;
  const { s, fetchImpl, clk } = store(() => json(docs[Math.min(n++, 1)]));
  await s.getKey('a');
  clk.advance(5);
  assert.equal(await s.getKey('b'), null, 'rate limited: no refetch yet');
  assert.equal(fetchImpl.calls.length, 1);
  clk.advance(26);
  assert.ok(await s.getKey('b'), 'forced refetch after 30 s finds the rotated key');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(await s.getKey('nope'), null);
  clk.advance(31);
  assert.equal(await s.getKey('nope'), null);
  assert.equal(fetchImpl.calls.length, 3);
});

test('no kid-less fallback: entries without a string kid are never served', async () => {
  const { s } = store({ keys: [{ ...ec.publicJwk }] });
  assert.equal(await s.getKey('anything'), null);
  assert.equal(await s.getKey(undefined), null);
  assert.equal(await s.getKey(''), null);
});

test('a private member anywhere makes the whole document invalid', async () => {
  const other = genEc();
  const { s } = store({ keys: [ecKey('a'), { ...ecKey('b', other), d: 'secret' }] });
  await rejectsKeyFetch(s.getKey('a'), /private key material/);
});

test('agent kind skips entries that are not EC P-256 or RSA, so one extra key never breaks the others', async () => {
  const rsa = genRsa('r1');
  const { s } = store({ keys: [
    { kty: 'EC', crv: 'P-384', x: ec.publicJwk.x, y: ec.publicJwk.y, kid: 'p384' },
    { ...ec.publicJwk, x: 'AA', kid: 'bad-x' },
    { kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'okp' },
    { kty: 'oct', k: 'AAAA', kid: 'oct' },
    { kty: 'RSA', kid: 'rsa-no-n' },
    { ...rsa.publicJwk, kid: 'rsa-rs256', alg: 'RS256' },
    { ...rsa.publicJwk, kid: 'rsa-enc', alg: 'PS384', use: 'enc' },
    { ...rsa.publicJwk, kid: 'rsa-ps384', alg: 'PS384' },
    { ...rsa.publicJwk, kid: 'rsa-noalg', alg: undefined },
    ecKey('good'),
  ] });
  assert.ok(await s.getKey('good'));
  assert.ok(await s.getKey('rsa-ps384'));
  assert.ok(await s.getKey('rsa-noalg'));
  for (const kid of ['p384', 'bad-x', 'okp', 'oct', 'rsa-no-n', 'rsa-rs256', 'rsa-enc']) assert.equal(await s.getKey(kid), null, kid);
  await rejectsKeyFetch(store({ keys: ['x'] }).s.getKey('a'), /malformed/);
});

test('a document that is not {keys:[...]} is invalid', async () => {
  await rejectsKeyFetch(store({ nokeys: [] }).s.getKey('a'), /no keys array/);
  await rejectsKeyFetch(store([]).s.getKey('a'), /no keys array/);
  await rejectsKeyFetch(store(() => new Response('<html>', { status: 200 })).s.getKey('a'), /not JSON/);
});

test('a repeated kid is refused', async () => {
  await rejectsKeyFetch(store({ keys: [ecKey('a'), ecKey('a', genEc())] }).s.getKey('a'), /repeats a key id/);
});

test('non-200 and a redirect status are refused, and a thrown redirect error is a fetch failure', async () => {
  await rejectsKeyFetch(store(() => new Response('x', { status: 500 })).s.getKey('a'), /HTTP 500/);
  await rejectsKeyFetch(store(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })).s.getKey('a'), /redirected/);
  await rejectsKeyFetch(store(() => { throw new TypeError('fetch failed'); }).s.getKey('a'), /could not be fetched/);
});

test('JWKS fetch refuses a real HTTP redirect (redirect: error) and does not follow it', async () => {
  let followed = false;
  const target = http.createServer((_q, r) => { followed = true; r.end('{"keys":[]}'); }).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const hop = http.createServer((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` }); r.end(); }).listen(0, '127.0.0.1');
  await new Promise((r) => hop.once('listening', r));
  try {
    const s = createKeyStore({ uri: `http://127.0.0.1:${hop.address().port}/jwks`, kind: 'agent', allowLoopback: true });
    await rejectsKeyFetch(s.getKey('a'), /could not be fetched|redirected/);
    assert.equal(followed, false);
  } finally { hop.close(); target.close(); }
});

test('a real loopback server works end to end when allowLoopback is on', async () => {
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ keys: [ecKey('a')] })); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const s = createKeyStore({ uri: `http://127.0.0.1:${srv.address().port}/jwks`, kind: 'agent', allowLoopback: true });
    assert.equal((await s.getKey('a')).crv, 'P-256');
  } finally { srv.close(); }
});

test('64 KiB cap is enforced while reading, not after', async () => {
  const big = () => new Response(new ReadableStream({
    start(c) { const chunk = new Uint8Array(8192).fill(32); for (let i = 0; i < 16; i += 1) c.enqueue(chunk); c.close(); },
  }), { status: 200 });
  await rejectsKeyFetch(store(big).s.getKey('a'), /too large/);
  // A body just under the cap is parsed (padding inside whitespace).
  const exact = JSON.stringify({ keys: [ecKey('a')] }).padEnd(MAX_JWKS_BYTES, ' ');
  assert.equal(exact.length, MAX_JWKS_BYTES);
  assert.ok(await store(() => new Response(exact, { status: 200 })).s.getKey('a'));
  await rejectsKeyFetch(store(() => new Response(exact + ' ', { status: 200 })).s.getKey('a'), /too large/);
  // A declared length over the cap is refused before reading.
  await rejectsKeyFetch(store(() => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_JWKS_BYTES + 1) } })).s.getKey('a'), /too large/);
});

test('a slow server is cut off by the timeout', async () => {
  const hang = (init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const { s } = store(hang, { timeoutMs: 30 });
  await rejectsKeyFetch(s.getKey('a'), /could not be fetched/);
});

test('URL rules: https, or http loopback only with allowLoopback', () => {
  assert.throws(() => createKeyStore({ uri: 'http://keys.example/jwks', kind: 'agent', allowLoopback: true }), /https/);
  assert.throws(() => createKeyStore({ uri: 'http://127.0.0.1:1/jwks', kind: 'agent', allowLoopback: false }), /ALLOW_LOOPBACK/);
  assert.doesNotThrow(() => createKeyStore({ uri: 'https://keys.example/jwks', kind: 'agent' }));
});

test('RSA kind ignores other key types and keys with a wrong alg or use', async () => {
  const rsa = genRsa('r1');
  const { s } = store({ keys: [ecKey('e1'), { ...rsa.publicJwk, kid: 'r-enc', use: 'enc' }, { ...rsa.publicJwk, kid: 'r-ps', alg: 'PS256' }, rsa.publicJwk] }, { kind: 'RSA' });
  assert.ok(await s.getKey('r1'));
  assert.equal(await s.getKey('e1'), null);
  assert.equal(await s.getKey('r-enc'), null);
  assert.equal(await s.getKey('r-ps'), null);
});

test('RSA kind still rejects a document with any private member', async () => {
  const rsa = genRsa('r1');
  await rejectsKeyFetch(store({ keys: [{ ...rsa.publicJwk, d: 'x' }] }, { kind: 'RSA' }).s.getKey('r1'), /private/);
});

test('concurrent lookups share one fetch', async () => {
  const { s, fetchImpl } = store(async () => { await new Promise((r) => setTimeout(r, 10)); return json({ keys: [ecKey('a')] }); });
  await Promise.all([s.getKey('a'), s.getKey('a'), s.getKey('a')]);
  assert.equal(fetchImpl.calls.length, 1);
});

test('jws: decodeJws is strict', () => {
  const good = signEs256({ alg: 'ES256' }, { a: 1 }, ec.privateKey);
  assert.deepEqual(decodeJws(good).payload, { a: 1 });
  for (const bad of ['', 'a.b', 'a.b.c.d', 'a..c', '***.b.c', null, undefined, 42, `${good}.x`]) assert.equal(decodeJws(bad), null, String(bad));
  const arr = `${Buffer.from('[]').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.AA`;
  assert.equal(decodeJws(arr), null, 'header must be an object');
  const notJson = `${Buffer.from('x').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.AA`;
  assert.equal(decodeJws(notJson), null);
});

test('jws: ES256 and RS256 verify, and refuse a tampered payload, a wrong key and a short signature', () => {
  const jws = signEs256({ alg: 'ES256' }, { a: 1 }, ec.privateKey);
  assert.equal(verifyEs256(decodeJws(jws), ec.publicJwk), true);
  assert.equal(verifyEs256(decodeJws(tamper(jws, 1, (p) => ({ ...p, a: 2 }))), ec.publicJwk), false);
  assert.equal(verifyEs256(decodeJws(jws), genEc().publicJwk), false);
  assert.equal(verifyEs256(decodeJws(`${jws.split('.').slice(0, 2).join('.')}.AAAA`), ec.publicJwk), false);
  assert.equal(verifyEs256(decodeJws(jws), { ...ec.publicJwk, d: 'x' }), false);
  const rsa = genRsa('r');
  const rs = signRs256({ alg: 'RS256' }, { a: 1 }, rsa.privateKey);
  assert.equal(verifyRs256(decodeJws(rs), rsa.publicJwk), true);
  assert.equal(verifyRs256(decodeJws(tamper(rs, 1, (p) => ({ ...p, a: 2 }))), rsa.publicJwk), false);
  assert.equal(verifyRs256(decodeJws(rs), genRsa('r2').publicJwk), false);
  const weak = genRsa('w', 1024);
  assert.equal(verifyRs256(decodeJws(signRs256({ alg: 'RS256' }, {}, weak.privateKey)), weak.publicJwk), false, 'under 2048 bits is refused');
});

test('jws: the thumbprint is the RFC 7638 base64url SHA-256 of {crv,kty,x,y}', () => {
  assert.equal(jwkThumbprint(ec.publicJwk), thumb(ec.publicJwk));
  assert.equal(jwkThumbprint({ ...ec.publicJwk, kid: 'ignored', alg: 'ES256' }), thumb(ec.publicJwk));
  assert.equal(isPublicEcP256Jwk(ec.publicJwk), true);
  assert.equal(isPublicEcP256Jwk({ ...ec.publicJwk, d: 'x' }), false);
});

test('jws: a crit header is refused for every algorithm (RFC 7515 4.1.11)', () => {
  assert.equal(decodeJws(signEs256({ alg: 'ES256', crit: ['exp'] }, { a: 1 }, ec.privateKey)), null);
  assert.equal(decodeJws(signEs256({ alg: 'ES256', crit: [] }, { a: 1 }, ec.privateKey)), null);
  assert.ok(decodeJws(signEs256({ alg: 'ES256' }, { a: 1 }, ec.privateKey)));
});

test('jws: PS384 verifies with salt length 48, refuses PS256 salts, a wrong key, a tampered payload and a 1024-bit key', () => {
  const rsa = genRsa('r');
  const jws = signPs384({ alg: 'PS384' }, { a: 1 }, rsa.privateKey);
  assert.equal(verifyPs384(decodeJws(jws), rsa.publicJwk), true);
  assert.equal(verifyPs384(decodeJws(tamper(jws, 1, (p) => ({ ...p, a: 2 }))), rsa.publicJwk), false);
  assert.equal(verifyPs384(decodeJws(jws), genRsa('o').publicJwk), false);
  assert.equal(verifyPs384(decodeJws(jws), ec.publicJwk), false);
  assert.equal(verifyPs384(decodeJws(jws), { ...rsa.publicJwk, d: 'x' }), false);
  const small = genRsa('s', 1024);
  assert.equal(verifyPs384(decodeJws(signPs384({ alg: 'PS384' }, { a: 1 }, small.privateKey)), small.publicJwk), false);
  // An RS256 (PKCS#1 v1.5) signature is not a PS384 signature.
  assert.equal(verifyPs384(decodeJws(signRs256({ alg: 'PS384' }, { a: 1 }, rsa.privateKey)), rsa.publicJwk), false);
});
