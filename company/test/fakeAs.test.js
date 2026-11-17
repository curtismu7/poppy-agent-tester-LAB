// Smoke test of the fake authorization server on its own (no Company, no lab): metadata, jwks, PAR, authorize, token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startFakeAs } from './fakeAs.js';
import { genEc, signEs256, thumb, b64u } from './helpers.js';
import { decodeJws, verifyRs256 } from '../src/jws.js';

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REDIRECT = 'http://127.0.0.1:5450/cb';
let as; let key; let kid;

before(async () => {
  key = genEc();
  kid = thumb(key.publicJwk);
  as = await startFakeAs({ clients: [{ id: CLIENT, jwks: [{ ...key.publicJwk, kid, alg: 'ES256', use: 'sig' }], redirectUri: REDIRECT }] });
});
after(() => as.close());

const assertion = (over = {}, { header = {}, signer = key.privateKey, aud } = {}) => {
  const t = Math.floor(Date.now() / 1000);
  return signEs256({ alg: 'ES256', typ: 'JWT', kid, ...header }, { iss: CLIENT, sub: CLIENT, aud: aud ?? `${as.origin}/par`, iat: t, exp: t + 60, jti: crypto.randomUUID(), ...over }, signer);
};
const form = (obj) => new URLSearchParams(obj).toString();
const post = (path, obj) => fetch(`${as.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(obj) });
const verifier = crypto.randomBytes(32).toString('base64url');
const parParams = (a, over = {}) => ({
  client_id: CLIENT, response_type: 'code', redirect_uri: REDIRECT, scope: 'accounts:read', state: 'st-1',
  code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: a, ...over,
});

test('metadata and jwks', async () => {
  const meta = await (await fetch(`${as.origin}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta, {
    issuer: as.origin, authorization_endpoint: `${as.origin}/authorize`, token_endpoint: `${as.origin}/token`, pushed_authorization_request_endpoint: `${as.origin}/par`,
    jwks_uri: `${as.origin}/jwks`, authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['private_key_jwt'], code_challenge_methods_supported: ['S256'],
  });
  const jwks = await (await fetch(meta.jwks_uri)).json();
  assert.equal(jwks.keys.length, 1);
  assert.deepEqual([jwks.keys[0].kty, jwks.keys[0].alg, jwks.keys[0].use, typeof jwks.keys[0].kid, 'd' in jwks.keys[0]], ['RSA', 'RS256', 'sig', 'string', false]);
});

test('a valid private_key_jwt PAR is accepted (201 request_uri), a bad one is refused', async () => {
  const ok = await post('/par', parParams(assertion()));
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.match(body.request_uri, /^urn:ietf:params:oauth:request_uri:/);
  assert.equal(body.expires_in, 60);

  const attempts = {
    'wrong signing key': parParams(assertion({}, { signer: genEc().privateKey })),
    'unknown kid': parParams(assertion({}, { header: { kid: 'nope' } })),
    'wrong alg label': parParams(assertion({}, { header: { alg: 'HS256' } })),
    'wrong typ': parParams(assertion({}, { header: { typ: 'client-authentication+jwt' } })),
    'iss is not the client': parParams(assertion({ iss: 'someone' })),
    'sub is not the client': parParams(assertion({ sub: 'someone' })),
    'aud is the issuer, mode endpoint': parParams(assertion({}, { aud: as.origin })),
    'aud is the token endpoint on PAR': parParams(assertion({}, { aud: `${as.origin}/token` })),
    'expired': parParams(assertion({ exp: Math.floor(Date.now() / 1000) - 5 })),
    'too long lived': parParams(assertion({ exp: Math.floor(Date.now() / 1000) + 600 })),
    'no jti': parParams(assertion({ jti: undefined })),
    'client_secret present': parParams(assertion(), { client_secret: 'x' }),
    'wrong assertion type': parParams(assertion(), { client_assertion_type: 'nope' }),
    'unknown client': parParams(assertion(), { client_id: 'other' }),
    'wrong redirect_uri': parParams(assertion(), { redirect_uri: 'http://127.0.0.1:5450/other' }),
    'no S256': parParams(assertion(), { code_challenge_method: 'plain' }),
    'garbage assertion': parParams('not.a.jwt'),
  };
  for (const [name, params] of Object.entries(attempts)) {
    const r = await post('/par', params);
    assert.ok(r.status === 400 || r.status === 401, `${name}: ${r.status}`);
    assert.equal(typeof (await r.json()).error, 'string', name);
  }
});

test('a replayed assertion (same jti) is refused', async () => {
  const a = assertion();
  assert.equal((await post('/par', parParams(a))).status, 201);
  assert.equal((await post('/par', parParams(a))).status, 401);
});

test('issuer assertionAudMode accepts aud = issuer and refuses the endpoint', async () => {
  as.knobs.assertionAudMode = 'issuer';
  try {
    assert.equal((await post('/par', parParams(assertion({}, { aud: as.origin })))).status, 201);
    assert.equal((await post('/par', parParams(assertion()))).status, 401);
  } finally { as.knobs.assertionAudMode = 'endpoint'; }
});

async function signIn() {
  const par = await (await post('/par', parParams(assertion()))).json();
  const auth = await fetch(`${as.origin}/authorize?client_id=${CLIENT}&request_uri=${encodeURIComponent(par.request_uri)}`, { redirect: 'manual' });
  assert.equal(auth.status, 302);
  return { location: new URL(auth.headers.get('location')), par };
}
const tokenParams = (code, over = {}) => ({
  grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT,
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion({}, { aud: `${as.origin}/token` }), ...over,
});

test('authorize auto-consents, and the token endpoint issues an RS256 access token that verifies against /jwks', async () => {
  const { location, par } = await signIn();
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'st-1');
  assert.equal(location.searchParams.get('iss'), as.origin);
  // The request_uri is single use.
  assert.equal((await fetch(`${as.origin}/authorize?client_id=${CLIENT}&request_uri=${encodeURIComponent(par.request_uri)}`, { redirect: 'manual' })).status, 400);

  const code = location.searchParams.get('code');
  const tok = await post('/token', tokenParams(code));
  assert.equal(tok.status, 200);
  const body = await tok.json();
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.scope, 'accounts:read');
  const jws = decodeJws(body.access_token);
  assert.deepEqual([jws.header.alg, jws.header.typ, jws.header.kid], ['RS256', 'at+jwt', as.kid]);
  assert.equal(jws.payload.iss, as.origin);
  assert.deepEqual(jws.payload.aud, ['https://company.example/poppy']);
  assert.equal(jws.payload.client_id, CLIENT);
  assert.equal(jws.payload.scope, 'accounts:read');
  assert.equal(verifyRs256(jws, as.publicJwk), true);
  // The code is single use.
  assert.equal((await post('/token', tokenParams(code, { client_assertion: assertion({}, { aud: `${as.origin}/token` }) }))).status, 400);
});

test('token endpoint refuses a wrong PKCE verifier, a wrong assertion aud, a client_secret, and a wrong redirect_uri', async () => {
  const cases = {
    'pkce': (c) => tokenParams(c, { code_verifier: 'wrong' }),
    'aud is the PAR endpoint': (c) => tokenParams(c, { client_assertion: assertion({}, { aud: `${as.origin}/par` }) }),
    'client_secret': (c) => tokenParams(c, { client_secret: 'x' }),
    'redirect_uri': (c) => tokenParams(c, { redirect_uri: 'http://127.0.0.1:5450/x' }),
    'grant type': (c) => tokenParams(c, { grant_type: 'client_credentials' }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const { location } = await signIn();
    const r = await post('/token', make(location.searchParams.get('code')));
    assert.ok(r.status === 400 || r.status === 401, `${name}: ${r.status}`);
  }
});

test('knobs: audience, expiry offset, scope', async () => {
  as.knobs.tokenAudience = 'https://other.example';
  as.knobs.tokenExpOffsetSeconds = -30;
  as.knobs.tokenScope = 'openid';
  try {
    const { location } = await signIn();
    const body = await (await post('/token', tokenParams(location.searchParams.get('code')))).json();
    const p = decodeJws(body.access_token).payload;
    assert.deepEqual(p.aud, ['https://other.example']);
    assert.ok(p.exp < Math.floor(Date.now() / 1000));
    assert.equal(p.scope, 'openid');
  } finally { Object.assign(as.knobs, { tokenAudience: 'https://company.example/poppy', tokenExpOffsetSeconds: 3600, tokenScope: 'accounts:read' }); }
});

test('every request is recorded, with the decoded assertion and no client_secret anywhere', async () => {
  assert.ok(as.requests.length > 10);
  const par = as.requestsTo('/par').filter((r) => r.status === 201);
  assert.ok(par.length > 0);
  for (const r of par) {
    assert.equal(r.body.client_id, CLIENT);
    assert.equal(r.assertion.payload.iss, CLIENT);
    assert.equal('client_secret' in r.body, false);
  }
  assert.ok(as.requests.every((r) => typeof r.method === 'string' && r.headers));
  assert.equal(b64u('x').length, 2);
});
