import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateEs256Key, decodeJws } from '../src/jose.js';
import { newPkce, authorizationUrl, clientAssertion, tokenRequest, ASSERTION_TYP } from '../src/oauth.js';
import { clientMetadata, jwksDocument } from '../src/agent.js';
import { verifyEs256 } from './helpers.js';

const CLIENT = 'https://agent.example/client.json';
const ISSUER = 'https://pf.example:9031';

test('PKCE challenge is the S256 hash of the verifier, and each one is new', () => {
  const a = newPkce(); const b = newPkce();
  assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(a.method, 'S256');
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.verifier.length >= 43);
});

test('authorization URL carries the URL client_id, PKCE and state, and survives hostile values', () => {
  const url = new URL(authorizationUrl({ authorizationEndpoint: `${ISSUER}/as/authorization.oauth2`, clientId: CLIENT, redirectUri: 'https://agent.example/cb', scope: 'accounts:read', state: 'a b&c=d', challenge: 'abc' }));
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'a b&c=d');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('client assertion: PingFederate needs typ client-authentication+jwt, aud = issuer, iss = sub = client URL', () => {
  const k = generateEs256Key();
  const a = clientAssertion({ clientId: CLIENT, issuer: ISSUER, kid: 'a1', signingKey: k.privateKey, now: 1_800_000_000 });
  const v = verifyEs256(a, k.publicJwk);
  assert.ok(v.ok);
  assert.equal(v.header.typ, ASSERTION_TYP);
  assert.equal(v.payload.iss, CLIENT);
  assert.equal(v.payload.sub, CLIENT);
  assert.equal(v.payload.aud, ISSUER);
  assert.equal(v.payload.exp - v.payload.iat, 60);
});

test('token request is a form post with the assertion and the verifier, and never a client secret', () => {
  const k = generateEs256Key();
  const r = tokenRequest({ tokenEndpoint: `${ISSUER}/as/token.oauth2`, clientId: CLIENT, issuer: ISSUER, kid: 'a1', signingKey: k.privateKey, code: 'C', redirectUri: 'https://agent.example/cb', verifier: 'V' });
  const form = new URLSearchParams(r.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code_verifier'), 'V');
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.ok(decodeJws(form.get('client_assertion')));
  assert.equal(form.get('client_secret'), null);
});

test('client metadata: client_id is its own URL, private_key_jwt, jwks_uri on the same host', () => {
  const m = clientMetadata({ baseUrl: 'https://agent.example', redirectUri: 'https://agent.example/cb' });
  assert.equal(m.client_id, CLIENT);
  assert.equal(m.token_endpoint_auth_method, 'private_key_jwt');
  assert.equal(new URL(m.jwks_uri).host, new URL(m.client_id).host);
  const k = generateEs256Key();
  assert.equal(jwksDocument(k.publicJwk, 'a1').keys[0].d, undefined);
});
