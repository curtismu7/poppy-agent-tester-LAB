// Registered-client mode for an authorization server with no CIMD support (PingOne). The client_id is a registered application id,
// not the agent's metadata URL. It applies to a sign-in only when the discovered issuer equals the configured PingOne issuer, so a
// PingFederate issuer never receives the registered id. No client secret exists: the agent signs a private_key_jwt assertion.
export const ASSERTION_AUDS = ['endpoint', 'issuer'];

const val = (v) => String(v ?? '').trim();

/** A message when the registered settings are wrong, else null. Only the assertion audience can be wrong. */
export function registeredProblem(env = process.env) {
  const aud = val(env.PAT_P1_ASSERTION_AUD);
  if (aud && !ASSERTION_AUDS.includes(aud)) return `PAT_P1_ASSERTION_AUD must be "endpoint" or "issuer" (got "${aud.slice(0, 40)}")`;
  return null;
}

/** null, or { clientId, issuer, assertionAud, assertionTyp } when both PAT_P1_CLIENT_ID and PAT_DEMO_P1_ISSUER are set and valid. */
export function registeredFrom(env = process.env) {
  const clientId = val(env.PAT_P1_CLIENT_ID);
  const issuer = val(env.PAT_DEMO_P1_ISSUER);
  if (!clientId || !issuer || registeredProblem(env)) return null;
  return { clientId, issuer, assertionAud: val(env.PAT_P1_ASSERTION_AUD) || 'endpoint', assertionTyp: val(env.PAT_P1_ASSERTION_TYP) || 'JWT' };
}

/** True when two issuer strings differ at most by trailing slashes. Nothing else is folded: another path or case is another issuer. */
export const sameIssuer = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The one place the client_id is chosen: the registered id only for the registered issuer, else the CIMD URL. */
export function clientFor({ registered, baseUrl, issuerClaim }) {
  if (registered && sameIssuer(issuerClaim, registered.issuer)) return { id: registered.clientId, kind: 'registered' };
  return { id: `${baseUrl}/client.json`, kind: 'cimd' };
}
