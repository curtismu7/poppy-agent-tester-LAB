// Poppy-Session verification (design 4.3 step 4, spec 5.2 and 5.3), the replay cache and the session binding.
// Every failure is 400 invalid_session with a distinct description. The first failing check wins. Descriptions never carry token text.
import crypto from 'node:crypto';
import { CompanyError, decodeJws, isPublicEcP256Jwk, jwkThumbprint, verifyEs256, verifyPs384 } from './jws.js';
import { KeyFetchError } from './keys.js';

export const DELEGATION_TYP = 'poppy-delegation+jwt';
export const SESSION_TYP = 'poppy-session+jwt';
export const MAX_DELEGATION_SECONDS = 24 * 3600;
export const IAT_WINDOW_SECONDS = 60;
// Longer than the whole iat window (2 x 60 s), so a session first used at iat-60 s is still remembered at iat+60 s.
export const REPLAY_TTL_MS = 180_000;
export const SESSION_TTL_MS = 24 * 3600 * 1000;
export const CACHE_CAP = 10_000;

const bad = (description) => new CompanyError(400, 'invalid_session', description);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isString = (v) => typeof v === 'string' && v !== '';

// Maps keep insertion order, so the oldest entries are first. An entry used again is re-inserted.
function prune(map, nowMs, cap) {
  for (const [k, v] of map) { if (v.expiresAt > nowMs) break; map.delete(k); }
  while (map.size >= cap) map.delete(map.keys().next().value);
}

/**
 * verifySession({ session, bearer, method, pathname }) -> { sid, sub, iss }.
 * bearer is null (no access token) or { token, clientId, sub } from a token that already verified (sub is only compared, never reported).
 * agentKeys.getKey(kid) serves the agent's EC P-256 keys.
 */
export function createSessionVerifier({ config, agentKeys, now = () => Date.now() }) {
  const replay = new Map(); // `${iss}|${jti}` -> { expiresAt }
  const sessions = new Map(); // sid -> { sub, iss, tokenSub, expiresAt }

  return async function verifySession({ session, bearer, method = 'GET', pathname }) {
    const nowMs = now();
    const nowSec = nowMs / 1000;

    // 4.1 / 4.2 The session JWT and its header.
    const s = decodeJws(session);
    if (!s) throw bad('Poppy-Session is not a compact JWS');
    if (s.header.typ !== SESSION_TYP) throw bad(`session typ must be ${SESSION_TYP}`);
    if (s.header.alg !== 'ES256') throw bad('session algorithm must be ES256');
    if (!isString(s.header.kid)) throw bad('session has no key id');
    if (!isString(s.header.poppy_dlg)) throw bad('session has no delegation (poppy_dlg)');

    // 4.3 The delegation.
    const d = decodeJws(s.header.poppy_dlg);
    if (!d) throw bad('delegation is not a compact JWS');
    if (d.header.typ !== DELEGATION_TYP) throw bad(`delegation typ must be ${DELEGATION_TYP}`);
    if (d.header.alg !== 'ES256' && d.header.alg !== 'PS384') throw bad('delegation algorithm must be ES256 or PS384');
    if (!isString(d.header.kid)) throw bad('delegation has no key id');
    const dp = d.payload;
    if (!isString(dp.iss)) throw bad('delegation has no iss');
    if (!isString(dp.jti)) throw bad('delegation has no jti');
    if (!isNumber(dp.iat) || !isNumber(dp.exp)) throw bad('delegation iat and exp must be numbers');
    if (dp.exp <= dp.iat) throw bad('delegation exp must be after iat');
    if (dp.exp - dp.iat > MAX_DELEGATION_SECONDS) throw bad('delegation lasts longer than 24 hours');
    if (dp.iat > nowSec + IAT_WINDOW_SECONDS) throw bad('delegation iat is in the future');
    if (!(dp.exp > nowSec)) throw bad('delegation is expired');
    const delegatedJwk = dp.cnf && typeof dp.cnf === 'object' ? dp.cnf.jwk : undefined;
    if (!isPublicEcP256Jwk(delegatedJwk)) throw bad('delegation cnf.jwk must be a public EC P-256 key');
    for (const forbidden of ['sub', 'agent_id', 'aud']) {
      if (forbidden in dp) throw bad(`delegation must not carry ${forbidden}`);
    }

    // 4.4 Only the configured agent.
    if (dp.iss !== config.agentClientId) throw bad('agent is not registered');

    // 4.5 The agent's keys sign the delegation.
    let agentJwk;
    try { agentJwk = await agentKeys.getKey(d.header.kid); } catch (e) {
      if (e instanceof KeyFetchError) throw bad('agent keys could not be fetched');
      throw e;
    }
    if (!agentJwk) throw bad('delegation key id is not one of the agent keys');
    if (!(d.header.alg === 'ES256' ? verifyEs256 : verifyPs384)(d, agentJwk)) throw bad('delegation signature is not valid');

    // 4.6 The delegated key signs the session, and kid is its thumbprint.
    if (s.header.kid !== jwkThumbprint(delegatedJwk)) throw bad('session kid is not the thumbprint of the delegated key');
    if (!verifyEs256(s, delegatedJwk)) throw bad('session signature is not valid');

    // 4.7 Claims.
    const p = s.payload;
    if (p.iss !== dp.iss) throw bad('session iss does not match the delegation');
    if (p.aud !== config.issuer) throw bad('session aud is not this Company');
    if (!isString(p.sid) || !isString(p.sub) || !isString(p.jti)) throw bad('session needs string sid, sub and jti');
    if (p.htm !== 'GET' || method !== 'GET') throw bad('session htm does not match the request');
    if (p.htu !== `${config.origin}${pathname}`) throw bad('session htu does not match the request');
    if (!isNumber(p.iat) || Math.abs(nowSec - p.iat) > IAT_WINDOW_SECONDS) throw bad('session iat is outside the accepted window');
    if (p.iat > dp.exp) throw bad('session iat is after the delegation expired');
    if (p.iat < dp.iat - IAT_WINDOW_SECONDS) throw bad('session iat is before the delegation was issued');

    // 4.8 ath.
    if (!bearer) {
      if (p.ath !== undefined) throw bad('session carries ath but the request has no access token');
    } else {
      const ath = crypto.createHash('sha256').update(bearer.token).digest('base64url');
      if (p.ath !== ath) throw bad('session ath does not match the access token');
      if (bearer.clientId !== p.iss) throw bad('access token was issued to a different client than the session');
    }

    // 4.9 / 4.10 Replay and binding are checked first and recorded only when everything above and below passed.
    const replayKey = `${p.iss}|${p.jti}`;
    const seen = replay.get(replayKey);
    if (seen && seen.expiresAt > nowMs) throw bad('session jti was already used');
    const bound = sessions.get(p.sid);
    const live = bound && bound.expiresAt > nowMs ? bound : null;
    if (live && (live.sub !== p.sub || live.iss !== p.iss)) throw bad('session id belongs to another user');
    // The sid also sticks to the user of the access token, so a token for one user cannot back a session that claims another.
    // This is trust on first use: the first request of a sid decides which token user it belongs to.
    const tokenSub = bearer && isString(bearer.sub) ? bearer.sub : null;
    if (live && tokenSub && live.tokenSub && live.tokenSub !== tokenSub) throw bad("session id was used with a different user's access token");

    replay.delete(replayKey);
    prune(replay, nowMs, CACHE_CAP);
    replay.set(replayKey, { expiresAt: nowMs + REPLAY_TTL_MS });
    if (bound) sessions.delete(p.sid);
    prune(sessions, nowMs, CACHE_CAP);
    sessions.set(p.sid, { sub: p.sub, iss: p.iss, tokenSub: tokenSub ?? live?.tokenSub ?? null, expiresAt: nowMs + SESSION_TTL_MS });
    return { sid: p.sid, sub: p.sub, iss: p.iss };
  };
}
