// The EXAMPLE run the hosted build shows. Values are invented (.example hosts, throwaway keys made at startup); the shapes are what a
// real run produces, because the real signers make them. Built in memory, never written to disk, so no token is committed.
import crypto from 'node:crypto';
import { generateEs256Key, jwkThumbprint, b64url, decodeJws } from './jose.js';
import { signDelegation, signSession } from './poppy.js';
import { clientAssertion } from './oauth.js';

let cached = null;
export function buildSample() {
  if (cached) return cached;
  const CO = 'https://company.example'; const ISSUER = 'https://pf.example:9031'; const CLIENT = 'https://agent.example/client.json';
  const agent = generateEs256Key(); const delegated = generateEs256Key(); const kid = jwkThumbprint(agent.publicJwk);
  const now = Math.floor(Date.now() / 1000);
  const claims = { scope: 'accounts:read', client_id: CLIENT, iss: ISSUER, aud: 'enduser.example', iat: now, exp: now + 3600, sub: 'example-person', jti: crypto.randomBytes(12).toString('base64url') };
  const token = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'example-key' }))}.${b64url(JSON.stringify(claims))}.EXAMPLE-SIGNATURE-NOT-REAL`;
  const delegation = signDelegation({ clientId: CLIENT, kid, signingKey: agent.privateKey, delegatedPublicJwk: delegated.publicJwk, now });
  const session = signSession({ delegation, delegatedKey: delegated, clientId: CLIENT, issuer: ISSUER, sid: 'sid-example', sub: claims.sub, method: 'GET', url: `${CO}/poppy/api/v1/me`, accessToken: token, now });
  const assertion = clientAssertion({ clientId: CLIENT, issuer: ISSUER, kid, signingKey: agent.privateKey, now });

  const run = {
    example: true,
    note: 'EXAMPLE run: invented values on .example hosts with throwaway keys. The shapes are real, because the real signers made them. The access token signature is a placeholder.',
    steps: [
      { kind: 'discover', request: { urls: [`${CO}/.well-known/poppy.json`, `${CO}/.well-known/oauth-protected-resource`] }, response: { checks: [
        { id: 'version', ok: true, note: 'protocol_version 0.3' }, { id: 'issuer', ok: true, note: `issuer ${ISSUER}` }, { id: 'scope_hints', ok: true, note: 'every scope has a scope_hint' },
        { id: 'resource', ok: true, note: `resource ${CO} must be exactly ${CO}` }, { id: 'authorization_servers', ok: true, note: 'the issuer is listed as an authorization server' }] } },
      { kind: 'authorize', request: { url: `${ISSUER}/as/authorization.oauth2?response_type=code&client_id=${encodeURIComponent(CLIENT)}&redirect_uri=https%3A%2F%2Fagent.example%2Fcb&scope=accounts%3Aread&state=EXAMPLE&code_challenge=EXAMPLE&code_challenge_method=S256` } },
      { kind: 'token', request: { method: 'POST', url: `${ISSUER}/as/token.oauth2`, body: `grant_type=authorization_code&code=EXAMPLE&client_id=${encodeURIComponent(CLIENT)}&code_verifier=EXAMPLE&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=${assertion}`, assertion: decodeJws(assertion) }, response: { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'accounts:read' }, claims } },
      { kind: 'call', request: { method: 'GET', url: `${CO}/poppy/api/v1/me`, headers: { authorization: `Bearer ${token}`, 'poppy-session': session, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, session: decodeJws(session), delegation: decodeJws(delegation) }, response: { status: 200, body: { user_id: 'example-person', session_id: 'sid-example', agent_id: CLIENT, scopes: ['accounts:read'] } } },
    ],
  };
  cached = run;
  return run;
}
