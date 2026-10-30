// OAuth client pieces for an agent identified by a client metadata URL (CIMD): PKCE, the authorization URL, a
// private_key_jwt client assertion and the code exchange. No client secret exists: the URL is the client_id.
import crypto from 'node:crypto';
import { signJws } from './jose.js';

export const ASSERTION_TYP = 'client-authentication+jwt';

export function newPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), method: 'S256' };
}

export function authorizationUrl({ authorizationEndpoint, clientId, redirectUri, scope, state, challenge }) {
  const u = new URL(authorizationEndpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

/** PingFederate wants the header typ client-authentication+jwt and aud equal to the issuer. */
export function clientAssertion({ clientId, issuer, kid, signingKey, now = Math.floor(Date.now() / 1000) }) {
  return signJws(
    { typ: ASSERTION_TYP, alg: 'ES256', kid },
    { iss: clientId, sub: clientId, aud: issuer, iat: now, exp: now + 60, jti: crypto.randomUUID() },
    signingKey,
  );
}

/** The token request as plain data, so the page can show it before it is sent. */
export function tokenRequest({ tokenEndpoint, clientId, issuer, kid, signingKey, code, redirectUri, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion({ clientId, issuer, kid, signingKey }),
  });
  return { url: tokenEndpoint, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() };
}
