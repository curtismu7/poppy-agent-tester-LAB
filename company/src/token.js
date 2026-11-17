// Access-token verification (design 4.3 step 3). The first failing check decides the answer. Descriptions never carry token text.
import { CompanyError, decodeJws, verifyRs256 } from './jws.js';
import { KeyFetchError } from './keys.js';

export const SCOPE = 'accounts:read';
const invalid = (description) => new CompanyError(401, 'invalid_token', description);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Returns verifyAccessToken(token) -> { claims, scopes, clientId }, or throws CompanyError. keyStore.getKey(kid) serves the AS RSA keys. */
export function createAccessTokenVerifier({ config, keyStore, now = () => Date.now() }) {
  const skew = config.clockSkewSeconds ?? 5;
  return async function verifyAccessToken(token) {
    // 3.1 Shape, pinned algorithm, key by kid, signature.
    const jws = decodeJws(token);
    if (!jws) throw invalid('token is not a signed JWT');
    if (jws.header.alg !== 'RS256') throw invalid('token algorithm must be RS256');
    if (typeof jws.header.kid !== 'string' || jws.header.kid === '') throw invalid('token has no key id');
    let jwk;
    try { jwk = await keyStore.getKey(jws.header.kid); } catch (e) {
      if (e instanceof KeyFetchError) throw new CompanyError(503, 'temporarily_unavailable', 'signing keys could not be fetched');
      throw e;
    }
    if (!jwk) throw invalid('token key id is not a signing key of the issuer');
    if (!verifyRs256(jws, jwk)) throw invalid('token signature is not valid');

    // 3.2 iss, exp, nbf.
    const claims = jws.payload;
    const nowSec = now() / 1000;
    if (claims.iss !== config.issuer) throw invalid('token issuer is not accepted');
    if (!isNumber(claims.exp) || !(claims.exp > nowSec - skew)) throw invalid('token is expired');
    if (claims.nbf !== undefined && (!isNumber(claims.nbf) || claims.nbf > nowSec + skew)) throw invalid('token is not valid yet');

    // 3.3 aud.
    const aud = claims.aud;
    if (!(aud === config.audience || (Array.isArray(aud) && aud.includes(config.audience)))) throw invalid('token audience is not this Company');

    // 3.4 No sender-constrained tokens.
    if (claims.cnf !== undefined) throw invalid('sender-constrained tokens are not supported');

    // 3.5 client_id (azp is not accepted).
    if (typeof claims.client_id !== 'string' || claims.client_id === '') throw invalid('token has no client_id');

    // 3.6 scope.
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(SCOPE)) throw new CompanyError(403, 'insufficient_scope', `token lacks the ${SCOPE} scope`, { scope: SCOPE });
    return { claims, scopes, clientId: claims.client_id };
  };
}
