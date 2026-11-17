// Test helpers. Signers are built inline from node:crypto (RS256 for the access token, ES256 for the delegation and the session).
// No lab code, no network: JWKS documents are served by a routed fake fetch.
import crypto from 'node:crypto';

export const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

/** A P-256 key pair built from createECDH (the repo bans crypto.generateKeyPair for EC keys). */
export function genEc() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const publicJwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  const privateKey = crypto.createPrivateKey({ key: { ...publicJwk, d: ecdh.getPrivateKey().toString('base64url') }, format: 'jwk' });
  return { privateKey, publicJwk };
}

export function genRsa(kid, modulusLength = 2048) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength });
  return { privateKey, publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }, kid };
}

export const thumb = (jwk) => crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
export const athOf = (token) => crypto.createHash('sha256').update(token).digest('base64url');

export function signEs256(header, payload, privateKey) {
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function signRs256(header, payload, privateKey) {
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** PS384 (RSASSA-PSS, SHA-384, salt length 48), the other delegation algorithm of spec 5.2. */
export function signPs384(header, payload, privateKey) {
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${crypto.sign('sha384', Buffer.from(input), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }).toString('base64url')}`;
}

/** Replaces one part of a compact JWS (0 header, 1 payload) without re-signing. */
export function tamper(jws, part, edit) {
  const parts = jws.split('.');
  parts[part] = b64u(edit(JSON.parse(Buffer.from(parts[part], 'base64url').toString())));
  return parts.join('.');
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetchImpl serving fixed routes. A route is a Response factory `() => Response`, or a plain object served as JSON. `calls` lists the URLs asked for. */
export function routedFetch(routes) {
  const f = async (url, init) => {
    f.calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    return typeof route === 'function' ? route(init) : json(route);
  };
  f.calls = [];
  f.count = (url) => f.calls.filter((c) => c.url === url).length;
  return f;
}

export function clock(startMs = 1_800_000_000_000) {
  const c = { ms: startMs, now: () => c.ms, advance: (seconds) => { c.ms += seconds * 1000; }, sec: () => Math.floor(c.ms / 1000) };
  return c;
}

export const ORIGIN = 'http://127.0.0.1:5452';
export const ISSUER = 'https://auth.example/env1/as';
export const AUDIENCE = 'https://company.example/poppy';
export const AGENT_ID = '11111111-2222-4333-8444-555555555555';
export const ME = '/poppy/api/v1/me';

export function testConfig(over = {}) {
  return {
    origin: ORIGIN, port: 5452, bind: '127.0.0.1', issuer: ISSUER, issuerJwksUri: `${ISSUER}/jwks`, audience: AUDIENCE,
    agentClientId: AGENT_ID, agentJwksUri: 'https://agent.example/jwks.json', allowLoopback: true, orgName: 'Reference Company', clockSkewSeconds: 5, ...over,
  };
}

/**
 * Everything a verification test needs: a clock, the config, an RS256 AS key, the agent key, a delegated key, a routed fetch
 * serving both JWKS documents, and builders for the access token, the delegation and the session.
 */
export function buildWorld(configOver = {}) {
  const clk = clock();
  const config = testConfig(configOver);
  const as = genRsa('as-key-1');
  const agent = genEc();
  const agentKid = 'agent-key-1';
  const delegated = genEc();
  const docs = { as: { keys: [as.publicJwk] }, agent: { keys: [{ ...agent.publicJwk, kid: agentKid, alg: 'ES256', use: 'sig' }] } };
  const fetchImpl = routedFetch({ [config.issuerJwksUri]: () => json(docs.as), [config.agentJwksUri]: () => json(docs.agent) });

  const w = {
    clk, config, as, agent, agentKid, delegated, docs, fetchImpl,
    token(over = {}, { header = {}, key = as.privateKey } = {}) {
      const t = clk.sec();
      const payload = { iss: ISSUER, aud: [AUDIENCE], client_id: AGENT_ID, scope: 'accounts:read', sub: 'token-sub-1', iat: t, exp: t + 3600, jti: crypto.randomUUID(), ...over };
      return signRs256({ alg: 'RS256', kid: as.kid, typ: 'at+jwt', ...header }, payload, key);
    },
    delegation(over = {}, { header = {}, key = agent.privateKey } = {}) {
      const t = clk.sec();
      const payload = { iss: AGENT_ID, iat: t, exp: t + 3600, jti: crypto.randomUUID(), cnf: { jwk: delegated.publicJwk }, ...over };
      return signEs256({ typ: 'poppy-delegation+jwt', alg: 'ES256', kid: agentKid, ...header }, payload, key);
    },
    session(over = {}, { header = {}, key = delegated.privateKey, token = null, delegation = null } = {}) {
      const payload = { iss: AGENT_ID, aud: ISSUER, sid: 'sid-1', sub: 'user-1', htm: 'GET', htu: `${ORIGIN}${ME}`, iat: clk.sec(), jti: crypto.randomUUID(), ...(token ? { ath: athOf(token) } : {}), ...over };
      return signEs256({ typ: 'poppy-session+jwt', alg: 'ES256', kid: thumb(delegated.publicJwk), poppy_dlg: delegation ?? w.delegation(), ...header }, payload, key);
    },
  };
  return w;
}
