// The agent side of the Poppy-Session header (spec 5.2): a delegation JWT signed by the agent's published key, naming a
// short-lived delegated key, and a session JWT signed by that delegated key for one request.
import crypto from 'node:crypto';
import { jwkThumbprint, signJws } from './jose.js';

export const DELEGATION_TYP = 'pap-delegation+jwt';
export const SESSION_TYP = 'poppy-session+jwt';
export const MAX_DELEGATION_SECONDS = 24 * 3600;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Delegation: iss = the agent's client_id URL, cnf.jwk = the delegated public key. Lifetime is capped at 24 hours. */
export function signDelegation({ clientId, kid, signingKey, delegatedPublicJwk, now = nowSeconds(), lifetimeSeconds = 3600 }) {
  if (!(lifetimeSeconds > 0 && lifetimeSeconds <= MAX_DELEGATION_SECONDS)) throw new RangeError('delegation lifetime must be between 1 second and 24 hours');
  return signJws(
    { typ: DELEGATION_TYP, alg: 'ES256', kid },
    { iss: clientId, iat: now, exp: now + lifetimeSeconds, jti: crypto.randomUUID(), cnf: { jwk: delegatedPublicJwk } },
    signingKey,
  );
}

/** Session for one request. htu has its query and fragment removed; ath binds it to the access token. */
export function signSession({ delegation, delegatedKey, clientId, issuer, sid, sub, method, url, accessToken, now = nowSeconds() }) {
  const payload = {
    iss: clientId,
    aud: issuer,
    sid,
    sub,
    htm: String(method).toUpperCase(),
    htu: String(url).split('#')[0].split('?')[0],
    iat: now,
    jti: crypto.randomUUID(),
  };
  if (accessToken) payload.ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
  return signJws({ typ: SESSION_TYP, alg: 'ES256', kid: jwkThumbprint(delegatedKey.publicJwk), pap_dlg: delegation }, payload, delegatedKey.privateKey);
}
