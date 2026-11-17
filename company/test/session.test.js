import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSessionVerifier } from '../src/poppySession.js';
import { createKeyStore } from '../src/keys.js';
import { CompanyError } from '../src/jws.js';
import { buildWorld, genEc, genRsa, signPs384, signEs256, thumb, athOf, tamper, json, routedFetch, ME, AGENT_ID, ISSUER, ORIGIN } from './helpers.js';

function setup(over = {}) {
  const w = buildWorld(over);
  const agentKeys = createKeyStore({ uri: w.config.agentJwksUri, kind: 'agent', fetchImpl: w.fetchImpl, now: w.clk.now, allowLoopback: true });
  w.verify = createSessionVerifier({ config: w.config, agentKeys, now: w.clk.now });
  w.run = (session, bearer = null, pathname = ME, method = 'GET') => w.verify({ session, bearer, method, pathname });
  return w;
}
const bad = (p, re) => assert.rejects(p, (e) => e instanceof CompanyError && e.status === 400 && e.code === 'invalid_session' && re.test(e.description), String(re));

test('a valid signed-out session verifies and returns sid, sub, iss', async () => {
  const w = setup();
  assert.deepEqual(await w.run(w.session()), { sid: 'sid-1', sub: 'user-1', iss: AGENT_ID });
});

test('a valid signed-in session binds ath to the token and the token client_id to iss', async () => {
  const w = setup();
  const token = w.token();
  assert.equal((await w.run(w.session({}, { token }), { token, clientId: AGENT_ID })).sub, 'user-1');
});

test('4.1 not a compact JWS', async () => {
  const w = setup();
  for (const s of ['x', 'a.b', 'a.b.c', 'a.b.c.d', '']) await bad(w.run(s), /not a compact JWS/);
});

test('4.2 session header: typ, alg, kid, poppy_dlg', async () => {
  const w = setup();
  await bad(w.run(w.session({}, { header: { typ: 'JWT' } })), /session typ/);
  await bad(w.run(w.session({}, { header: { typ: undefined } })), /session typ/);
  for (const alg of ['none', 'HS256', 'PS384', 'RS256', 'es256']) await bad(w.run(w.session({}, { header: { alg } })), /session algorithm must be ES256/);
  await bad(w.run(w.session({}, { header: { kid: undefined } })), /no key id/);
  await bad(w.run(w.session({}, { header: { kid: 5 } })), /no key id/);
  await bad(w.run(w.session({}, { header: { poppy_dlg: undefined } })), /no delegation/);
  await bad(w.run(w.session({}, { header: { poppy_dlg: 7 } })), /no delegation/);
});

test('a session signed directly with an agent key (no delegation) is refused', async () => {
  const w = setup();
  const t = w.clk.sec();
  const direct = signEs256({ typ: 'poppy-session+jwt', alg: 'ES256', kid: w.agentKid }, { iss: AGENT_ID, aud: ISSUER, sid: 's', sub: 'u', htm: 'GET', htu: `${ORIGIN}${ME}`, iat: t, jti: 'j' }, w.agent.privateKey);
  await bad(w.run(direct), /no delegation/);
});

test('4.3 delegation structure', async () => {
  const w = setup();
  const run = (over, opts) => w.run(w.session({}, { delegation: w.delegation(over, opts) }));
  await bad(w.run(w.session({}, { delegation: 'nonsense' })), /delegation is not a compact JWS/);
  await bad(run({}, { header: { typ: 'JWT' } }), /delegation typ/);
  await bad(run({}, { header: { alg: 'PS256' } }), /delegation algorithm must be ES256 or PS384/);
  await bad(run({}, { header: { alg: 'PS384' } }), /delegation signature/); // allowed algorithm, but an EC key cannot verify it
  await bad(run({}, { header: { alg: 'none' } }), /delegation algorithm must be ES256 or PS384/);
  await bad(run({}, { header: { kid: undefined } }), /delegation has no key id/);
  await bad(run({ iss: undefined }), /no iss/);
  await bad(run({ jti: undefined }), /no jti/);
  await bad(run({ iat: undefined }), /iat and exp/);
  await bad(run({ exp: 'soon' }), /iat and exp/);
  const t = w.clk.sec();
  await bad(run({ iat: t, exp: t + 86401 }), /longer than 24 hours/);
  await run({ iat: t, exp: t + 86400 });
  await bad(run({ iat: t - 100, exp: t - 10 }), /expired/);
  await bad(run({ iat: t + 100, exp: t + 50 }), /exp must be after iat/);
  await bad(run({ cnf: undefined }), /cnf\.jwk/);
  await bad(run({ cnf: { jwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' } } }), /cnf\.jwk/);
  await bad(run({ cnf: { jwk: { ...w.delegated.publicJwk, crv: 'P-384' } } }), /cnf\.jwk/);
  await bad(run({ cnf: { jwk: { ...w.delegated.publicJwk, d: 'x' } } }), /cnf\.jwk/);
  await bad(run({ cnf: { jkt: 'abc' } }), /cnf\.jwk/);
});

test('4.3 a delegation must not carry sub, agent_id or aud', async () => {
  const w = setup();
  for (const [k, v] of [['sub', 'user-1'], ['agent_id', 'a'], ['aud', ISSUER]]) {
    await bad(w.run(w.session({}, { delegation: w.delegation({ [k]: v }) })), new RegExp(`must not carry ${k}`));
  }
});

test('4.4 unknown agent: the delegation iss is not the registered client', async () => {
  const w = setup();
  await bad(w.run(w.session({ iss: 'someone-else' }, { delegation: w.delegation({ iss: 'someone-else' }) })), /agent is not registered/);
});

test('4.5 agent keys: unknown kid, bad signature, fetch failure, JWKS with a private member', async () => {
  const w = setup();
  await bad(w.run(w.session({}, { delegation: w.delegation({}, { header: { kid: 'nope' } }) })), /not one of the agent keys/);
  await bad(w.run(w.session({}, { delegation: w.delegation({}, { key: genEc().privateKey }) })), /delegation signature/);
  await bad(w.run(w.session({}, { delegation: tamper(w.delegation(), 1, (p) => ({ ...p, exp: p.exp + 1 })) })), /delegation signature/);

  const down = setup();
  down.docs.agent = null;
  const fetchImpl = routedFetch({ [down.config.agentJwksUri]: () => json({ e: 1 }, 503) });
  const v = createSessionVerifier({ config: down.config, agentKeys: createKeyStore({ uri: down.config.agentJwksUri, kind: 'agent', fetchImpl, now: down.clk.now, allowLoopback: true }), now: down.clk.now });
  await bad(v({ session: down.session(), bearer: null, method: 'GET', pathname: ME }), /agent keys could not be fetched/);

  const leaky = setup();
  leaky.docs.agent.keys[0].d = 'secret';
  await bad(leaky.run(leaky.session()), /agent keys could not be fetched/);
});

test('4.5 the agent kid is looked up in a refreshed JWKS after a rotation (once per 30 s)', async () => {
  const w = setup();
  await w.run(w.session());
  const k2 = genEc();
  const signer = k2.privateKey;
  w.docs.agent.keys.push({ ...k2.publicJwk, kid: 'agent-key-2', alg: 'ES256', use: 'sig' });
  const s = () => w.session({ jti: crypto.randomUUID() }, { delegation: w.delegation({}, { header: { kid: 'agent-key-2' }, key: signer }) });
  await bad(w.run(s()), /not one of the agent keys/);
  w.clk.advance(31);
  await w.run(s());
});

test('4.6 session kid must be the thumbprint of cnf.jwk, and the session signed by that key', async () => {
  const w = setup();
  await bad(w.run(w.session({}, { header: { kid: 'x' } })), /thumbprint/);
  await bad(w.run(w.session({}, { header: { kid: thumb(genEc().publicJwk) } })), /thumbprint/);
  await bad(w.run(w.session({}, { key: genEc().privateKey })), /session signature/);
  await bad(w.run(tamper(w.session(), 1, (p) => ({ ...p, sub: 'attacker' }))), /session signature/);
  // Signed with the agent key instead of the delegated key.
  await bad(w.run(w.session({}, { key: w.agent.privateKey })), /session signature/);
});

test('4.7 claims: iss, aud, string ids, htm, htu, iat, delegation expiry', async () => {
  const w = setup();
  const run = (over) => w.run(w.session(over));
  await bad(run({ iss: 'other' }), /iss does not match/);
  await bad(run({ aud: 'https://other.example/as' }), /aud is not this Company/);
  await bad(run({ aud: [ISSUER] }), /aud is not this Company/);
  await bad(run({ aud: ORIGIN }), /aud is not this Company/);
  await bad(run({ sid: undefined }), /string sid, sub and jti/);
  await bad(run({ sub: 5 }), /string sid, sub and jti/);
  await bad(run({ jti: '' }), /string sid, sub and jti/);
  await bad(run({ htm: 'POST' }), /htm/);
  await bad(run({ htm: 'get' }), /htm/);
  await bad(run({ htu: `${ORIGIN}/poppy/api/v1/other` }), /htu/);
  await bad(run({ htu: `http://127.0.0.1:9999${ME}` }), /htu/);
  await bad(run({ htu: `${ORIGIN}${ME}?x=1` }), /htu/);
  await bad(run({ htu: undefined }), /htu/);
  const t = w.clk.sec();
  await bad(run({ iat: t - 61 }), /iat is outside/);
  await bad(run({ iat: t + 61 }), /iat is outside/);
  await bad(run({ iat: undefined }), /iat is outside/);
  await bad(run({ iat: String(t) }), /iat is outside/);
  await run({ iat: t - 59 });
  await run({ iat: t + 59 });
});

test('4.7 htm is checked against the request method too', async () => {
  const w = setup();
  await bad(w.run(w.session(), null, ME, 'POST'), /htm/);
});

test('4.7 htu is compared with the configured origin plus the request path', async () => {
  const w = setup();
  await bad(w.run(w.session(), null, '/poppy/api/v1/me/'), /htu/);
});

test('4.7 session iat after the delegation expired', async () => {
  const w = setup();
  const t = w.clk.sec();
  const d = w.delegation({ iat: t - 3000, exp: t + 30 });
  await w.run(w.session({ iat: t + 30 }, { delegation: d }));
  await bad(w.run(w.session({ iat: t + 31 }, { delegation: d })), /after the delegation expired/);
});

test('4.8 ath: absent without a token, required and exact with one, client_id must equal iss', async () => {
  const w = setup();
  const token = w.token();
  const bearer = { token, clientId: AGENT_ID };
  await bad(w.run(w.session({ ath: athOf(token) })), /carries ath but the request has no access token/);
  await bad(w.run(w.session(), bearer), /ath does not match/);
  await bad(w.run(w.session({ ath: athOf('another token') }), bearer), /ath does not match/);
  await bad(w.run(w.session({ ath: `${athOf(token)}=` }), bearer), /ath does not match/);
  await bad(w.run(w.session({}, { token }), { token, clientId: 'different-client' }), /different client/);
  await w.run(w.session({}, { token }), bearer);
});

test('4.9 replay: the same session twice is refused; the entry outlives the iat window and expires after 180 s', async () => {
  const w = setup();
  const s = w.session({ jti: 'fixed-jti' });
  await w.run(s);
  await bad(w.run(s), /jti was already used/);
  w.clk.advance(121);
  // The iat window (60 s) has closed by then, so a replay fails on iat, and the cache entry is still there (180 s).
  await bad(w.run(s), /iat is outside/);
  await bad(w.run(w.session({ jti: 'fixed-jti' })), /already used/);
  // A fresh session with the same jti after the TTL is accepted again: the cache entry is gone.
  w.clk.advance(60);
  await w.run(w.session({ jti: 'fixed-jti' }));
});

test('4.9 replay is recorded only after every check passed', async () => {
  const w = setup();
  const wrongPath = w.session({ jti: 'j-1', htu: `${ORIGIN}/elsewhere` });
  await bad(w.run(wrongPath), /htu/);
  await bad(w.run(wrongPath), /htu/); // still the htu failure, not "already used"
  const noAth = w.session({ jti: 'j-2' });
  await bad(w.run(noAth, { token: 't', clientId: AGENT_ID }), /ath does not match/);
  await bad(w.run(noAth, { token: 't', clientId: AGENT_ID }), /ath does not match/);
  // Binding failure is also not recorded: sid-1 belongs to user-1.
  await w.run(w.session({ jti: 'j-3' }));
  const other = w.session({ jti: 'j-4', sub: 'user-2' });
  await bad(w.run(other), /belongs to another user/);
  await bad(w.run(other), /belongs to another user/);
});

test('4.9 the replay key includes iss and jti', async () => {
  const w = setup();
  await w.run(w.session({ jti: 'same' }));
  await w.run(w.session({ jti: 'same-2' }));
  await bad(w.run(w.session({ jti: 'same' })), /already used/);
});

test('4.10 session binding: a sid sticks to its sub', async () => {
  const w = setup();
  await w.run(w.session({ sid: 'S', sub: 'alice' }));
  await w.run(w.session({ sid: 'S', sub: 'alice' }));
  await bad(w.run(w.session({ sid: 'S', sub: 'bob' })), /belongs to another user/);
  await w.run(w.session({ sid: 'S2', sub: 'bob' }));
});

test('4.10 a binding that is used again stays alive (TTL slides from the last use)', async () => {
  const w = setup();
  await w.run(w.session({ sid: 'S', sub: 'alice' }));
  w.clk.advance(23 * 3600);
  await w.run(w.session({ sid: 'S', sub: 'alice' }));
  w.clk.advance(23 * 3600);
  await bad(w.run(w.session({ sid: 'S', sub: 'bob' })), /belongs to another user/);
});

test('4.10 an old sid binding is forgotten after 24 h of silence', async () => {
  const w = setup();
  await w.run(w.session({ sid: 'S', sub: 'alice' }));
  w.clk.advance(24 * 3600 + 1);
  await w.run(w.session({ sid: 'S', sub: 'bob' }));
});

test('caches are bounded: 10000 sessions in, the oldest binding is dropped', async () => {
  const w = setup();
  await w.run(w.session({ sid: 'first', sub: 'alice' }));
  for (let i = 0; i < 10_000; i += 1) await w.run(w.session({ sid: `s-${i}`, sub: 'x', jti: `j-${i}` }));
  // 'first' was evicted to stay under the cap, so another sub may now use that sid.
  await w.run(w.session({ sid: 'first', sub: 'bob' }));
});

test('descriptions never contain the session, the delegation or token text', async () => {
  const w = setup();
  const s = w.session({ aud: 'https://other.example' });
  await assert.rejects(w.run(s), (e) => !e.description.includes(s.split('.')[0]) && !e.description.includes(s.split('.')[1]) && !e.description.includes('user-1'));
});

// ---- review findings (2026-11-17)

test('finding: the token user is bound to the sid, so one sid cannot carry two token users', async () => {
  const w = setup();
  const t1 = w.token({ sub: 'alice' });
  const t2 = w.token({ sub: 'mallory' });
  const b = (t, sub) => ({ token: t, clientId: AGENT_ID, sub });
  await w.run(w.session({ sid: 'S', sub: 'alice', jti: 'a1' }, { token: t1 }), b(t1, 'alice'));
  await w.run(w.session({ sid: 'S', sub: 'alice', jti: 'a2' }, { token: t1 }), b(t1, 'alice'));
  await bad(w.run(w.session({ sid: 'S', sub: 'alice', jti: 'a3' }, { token: t2 }), b(t2, 'mallory')), /different user's access token/);
  // A signed-out call does not erase the binding, and a token without a binding yet gets one.
  await w.run(w.session({ sid: 'S', sub: 'alice', jti: 'a4' }));
  await bad(w.run(w.session({ sid: 'S', sub: 'alice', jti: 'a5' }, { token: t2 }), b(t2, 'mallory')), /different user's access token/);
  await w.run(w.session({ sid: 'S9', sub: 'carol', jti: 'c1' }));
  await w.run(w.session({ sid: 'S9', sub: 'carol', jti: 'c2' }, { token: t1 }), b(t1, 'alice'));
  await bad(w.run(w.session({ sid: 'S9', sub: 'carol', jti: 'c3' }, { token: t2 }), b(t2, 'mallory')), /different user's access token/);
});

test('finding: a PS384 delegation signed by an RSA agent key is accepted (spec 5.2), ES256 still works', async () => {
  const w = setup();
  const rsa = genRsa('agent-rsa');
  w.docs.agent.keys.push({ kty: 'RSA', n: rsa.publicJwk.n, e: rsa.publicJwk.e, kid: 'agent-rsa', alg: 'PS384', use: 'sig' });
  const t = w.clk.sec();
  const ps = (over = {}, key = rsa.privateKey) => signPs384({ typ: 'poppy-delegation+jwt', alg: 'PS384', kid: 'agent-rsa' }, { iss: AGENT_ID, iat: t, exp: t + 3600, jti: 'd1', cnf: { jwk: w.delegated.publicJwk }, ...over }, key);
  assert.equal((await w.run(w.session({ jti: 's1' }, { delegation: ps() }))).sub, 'user-1');
  assert.equal((await w.run(w.session({ jti: 's2' }))).sub, 'user-1');
  await bad(w.run(w.session({ jti: 's3' }, { delegation: ps({}, genRsa('x').privateKey) })), /delegation signature/);
  await bad(w.run(w.session({ jti: 's4' }, { delegation: tamper(ps(), 1, (p) => ({ ...p, exp: p.exp + 1 })) })), /delegation signature/);
  // The algorithm must match the key type: PS384 header with the EC key, ES256 header with the RSA key.
  await bad(w.run(w.session({ jti: 's5' }, { delegation: signPs384({ typ: 'poppy-delegation+jwt', alg: 'PS384', kid: w.agentKid }, { iss: AGENT_ID, iat: t, exp: t + 60, jti: 'd', cnf: { jwk: w.delegated.publicJwk } }, rsa.privateKey) })), /delegation signature/);
  await bad(w.run(w.session({ jti: 's6' }, { delegation: w.delegation({}, { header: { kid: 'agent-rsa' } }) })), /delegation signature/);
  // PS256, RS256 and the rest stay refused.
  for (const alg of ['PS256', 'RS256', 'none', 'HS256']) await bad(w.run(w.session({ jti: `s-${alg}` }, { delegation: ps({}, rsa.privateKey).replace(/^[^.]+/, Buffer.from(JSON.stringify({ typ: 'poppy-delegation+jwt', alg, kid: 'agent-rsa' })).toString('base64url')) })), /delegation algorithm must be ES256 or PS384/);
});

test('finding: an RSA agent key under 2048 bits is not accepted for PS384', async () => {
  const w = setup();
  const small = genRsa('agent-small', 1024);
  w.docs.agent.keys.push({ kty: 'RSA', n: small.publicJwk.n, e: small.publicJwk.e, kid: 'agent-small', alg: 'PS384', use: 'sig' });
  const t = w.clk.sec();
  const d = signPs384({ typ: 'poppy-delegation+jwt', alg: 'PS384', kid: 'agent-small' }, { iss: AGENT_ID, iat: t, exp: t + 60, jti: 'd', cnf: { jwk: w.delegated.publicJwk } }, small.privateKey);
  await bad(w.run(w.session({}, { delegation: d })), /delegation signature/);
});

test('finding: delegation iat is checked, so the 24 h cap cannot be shifted into the future', async () => {
  const w = setup();
  const t = w.clk.sec();
  const year = 365 * 86400;
  await bad(w.run(w.session({}, { delegation: w.delegation({ iat: t + year, exp: t + year + 86400 }) })), /iat is in the future/);
  await bad(w.run(w.session({ jti: 'x2' }, { delegation: w.delegation({ iat: t + 61, exp: t + 3000 }) })), /iat is in the future/);
  await w.run(w.session({ jti: 'x3' }, { delegation: w.delegation({ iat: t + 59, exp: t + 3000 }) }));
  // Session iat must not precede the delegation by more than the window.
  const d = w.delegation({ iat: t + 59, exp: t + 3000 });
  await bad(w.run(w.session({ jti: 'x4', iat: t - 5 }, { delegation: d })), /before the delegation was issued/);
  await w.run(w.session({ jti: 'x5', iat: t - 1 }, { delegation: d }));
});

test('finding: a JOSE crit header is refused on the session and the delegation (RFC 7515 4.1.11)', async () => {
  const w = setup();
  await bad(w.run(w.session({}, { header: { crit: ['x'], x: 1 } })), /not a compact JWS/);
  await bad(w.run(w.session({ jti: 'c2' }, { delegation: w.delegation({}, { header: { crit: ['x'], x: 1 } }) })), /delegation is not a compact JWS/);
});

test('finding: a replay at the far edge of the iat window is still refused', async () => {
  const w = setup();
  const s = w.session({ jti: 'edge', iat: w.clk.sec() + 60 }); // iat is 60 s ahead of the clock: the first instant the window accepts
  await w.run(s); // first use at iat - 60
  w.clk.advance(120); // clock = iat + 60: the last instant the window accepts
  await bad(w.run(s), /already used/);
});
