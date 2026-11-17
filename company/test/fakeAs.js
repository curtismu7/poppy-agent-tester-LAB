// A fake OAuth authorization server for the end-to-end test (design 7.1). Plain node:http on 127.0.0.1, no dependencies.
// It behaves like a PingOne-style AS with a registered private_key_jwt client: RFC 8414 metadata, PAR (RFC 9126), an
// auto-consent authorize endpoint, a token endpoint with PKCE, and an RS256 access-token signer. It verifies client
// assertions on its own (it does not reuse the Company's verifier). Every request is recorded in `requests`.
import crypto from 'node:crypto';
import http from 'node:http';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_BODY = 64 * 1024;
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

function decode(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()), payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()), input: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2], 'base64url') };
  } catch { return null; }
}

function verifyEs256(jws, jwk) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return jws.sig.length === 64 && crypto.verify('sha256', Buffer.from(jws.input), { key, dsaEncoding: 'ieee-p1363' }, jws.sig);
  } catch { return false; }
}

/**
 * clients: [{ id, jwks: [publicJwk with kid, ...], redirectUri }]  (the registered clients, exactly as PingOne would hold them)
 * knobs (mutable at any time via `as.knobs`):
 *   tokenAudience            access-token aud, default `audience`
 *   tokenExpOffsetSeconds    exp = now + this, default 3600 (use a negative number for an expired token)
 *   assertionAudMode         'endpoint' (aud is the URL called) or 'issuer'
 *   assertionTyp             required client-assertion header typ, default 'JWT'
 *   tokenScope               scope in the access token, default 'accounts:read'
 *   userSub                  token sub, default 'fake-user-sub-1'
 */
export async function startFakeAs({ clients = [], audience = 'https://company.example/poppy', port = 0 } = {}) {
  const knobs = { tokenAudience: audience, tokenExpOffsetSeconds: 3600, assertionAudMode: 'endpoint', assertionTyp: 'JWT', tokenScope: 'accounts:read', userSub: 'fake-user-sub-1' };
  const registry = new Map(clients.map((c) => [c.id, c]));
  const requests = [];
  const pushed = new Map(); // request_uri -> { params, expiresAt }
  const codes = new Map(); // code -> { clientId, redirectUri, challenge, scope, expiresAt }
  const seenJti = new Set();

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-as-key-1';
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  let origin = '';
  const metadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    pushed_authorization_request_endpoint: `${origin}/par`,
    jwks_uri: `${origin}/jwks`,
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    code_challenge_methods_supported: ['S256'],
  });

  const send = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(text);
  };
  const oauthError = (res, status, error, error_description) => send(res, status, { error, error_description });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** Client authentication: returns { client, assertion } or an { error:[status, code, description] }. */
  function authenticate(params, expectedAud) {
    const fail = (status, code, description) => ({ error: [status, code, description] });
    if ('client_secret' in params) return fail(400, 'invalid_request', 'client_secret is not accepted for a private_key_jwt client');
    if (params.client_assertion_type !== ASSERTION_TYPE) return fail(401, 'invalid_client', 'client_assertion_type is wrong');
    const a = decode(params.client_assertion);
    if (!a) return fail(401, 'invalid_client', 'client_assertion is not a JWT');
    const clientId = params.client_id;
    const client = registry.get(clientId);
    if (!client) return fail(401, 'invalid_client', 'unknown client');
    if (a.header.alg !== 'ES256') return fail(401, 'invalid_client', 'assertion alg must be ES256');
    if (a.header.typ !== knobs.assertionTyp) return fail(401, 'invalid_client', `assertion typ must be ${knobs.assertionTyp}`);
    const jwk = client.jwks.find((k) => typeof a.header.kid === 'string' && k.kid === a.header.kid);
    if (!jwk) return fail(401, 'invalid_client', 'assertion kid is not registered');
    if ('d' in jwk) return fail(500, 'server_error', 'registered key has a private member');
    if (!verifyEs256(a, jwk)) return fail(401, 'invalid_client', 'assertion signature is not valid');
    const p = a.payload;
    if (p.iss !== clientId || p.sub !== clientId) return fail(401, 'invalid_client', 'assertion iss and sub must equal client_id');
    const aud = knobs.assertionAudMode === 'issuer' ? origin : expectedAud;
    if (p.aud !== aud) return fail(401, 'invalid_client', `assertion aud must be ${aud}`);
    const nowSec = Date.now() / 1000;
    if (typeof p.exp !== 'number' || p.exp <= nowSec) return fail(401, 'invalid_client', 'assertion is expired');
    if (p.exp > nowSec + 120) return fail(401, 'invalid_client', 'assertion lives longer than 120 seconds');
    if (typeof p.jti !== 'string' || p.jti === '') return fail(401, 'invalid_client', 'assertion has no jti');
    if (seenJti.has(`${clientId}|${p.jti}`)) return fail(401, 'invalid_client', 'assertion jti was already used');
    seenJti.add(`${clientId}|${p.jti}`);
    return { client, assertion: { header: a.header, payload: a.payload } };
  }

  function accessToken(clientId, scope) {
    const t = Math.floor(Date.now() / 1000);
    const input = `${b64u({ alg: 'RS256', kid, typ: 'at+jwt' })}.${b64u({ iss: origin, aud: [knobs.tokenAudience], client_id: clientId, scope, sub: knobs.userSub, iat: t, exp: t + knobs.tokenExpOffsetSeconds, jti: crypto.randomUUID() })}`;
    return `${input}.${crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
  }

  async function handle(req, res, rec) {
    const url = new URL(req.url, 'http://x');
    rec.path = url.pathname;
    rec.query = Object.fromEntries(url.searchParams);
    const method = req.method;

    if (method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return send(res, 200, metadata());
    if (method === 'GET' && url.pathname === '/jwks') return send(res, 200, { keys: [publicJwk] });

    if (method === 'POST' && (url.pathname === '/par' || url.pathname === '/token')) {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      rec.body = params;
      const isPar = url.pathname === '/par';
      const auth = authenticate(params, `${origin}${url.pathname}`);
      if (auth.error) return oauthError(res, ...auth.error);
      rec.assertion = auth.assertion;
      const { client } = auth;

      if (isPar) {
        if (params.redirect_uri !== client.redirectUri) return oauthError(res, 400, 'invalid_request', 'redirect_uri is not the registered one');
        if (params.code_challenge_method !== 'S256' || !params.code_challenge) return oauthError(res, 400, 'invalid_request', 'PKCE with S256 is required');
        if (params.response_type !== 'code') return oauthError(res, 400, 'unsupported_response_type', 'response_type must be code');
        const requestUri = `urn:ietf:params:oauth:request_uri:${crypto.randomUUID()}`;
        pushed.set(requestUri, { params, expiresAt: Date.now() + 60_000 });
        return send(res, 201, { request_uri: requestUri, expires_in: 60 });
      }

      if (params.grant_type !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code');
      const grant = codes.get(params.code);
      codes.delete(params.code); // one use
      if (!grant || grant.expiresAt < Date.now() || grant.clientId !== client.id) return oauthError(res, 400, 'invalid_grant', 'code is unknown, expired or used');
      if (params.redirect_uri !== grant.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
      const challenge = crypto.createHash('sha256').update(params.code_verifier ?? '').digest('base64url');
      if (!params.code_verifier || challenge !== grant.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return send(res, 200, { access_token: accessToken(client.id, knobs.tokenScope), token_type: 'Bearer', expires_in: Math.max(1, knobs.tokenExpOffsetSeconds), scope: knobs.tokenScope });
    }

    if (method === 'GET' && url.pathname === '/authorize') {
      const entry = pushed.get(url.searchParams.get('request_uri'));
      pushed.delete(url.searchParams.get('request_uri')); // one use
      if (!entry || entry.expiresAt < Date.now() || entry.params.client_id !== url.searchParams.get('client_id')) return oauthError(res, 400, 'invalid_request', 'request_uri is unknown, expired or for another client');
      const { params } = entry;
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { clientId: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, expiresAt: Date.now() + 60_000 });
      const back = new URL(params.redirect_uri);
      back.searchParams.set('code', code);
      if (params.state) back.searchParams.set('state', params.state);
      back.searchParams.set('iss', origin);
      res.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' });
      return res.end();
    }
    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer(async (req, res) => {
    const rec = { method: req.method, path: req.url, query: {}, headers: { ...req.headers }, body: null, assertion: null, status: null };
    requests.push(rec);
    res.on('finish', () => { rec.status = res.statusCode; });
    try { await handle(req, res, rec); } catch { if (!res.headersSent) send(res, 500, { error: 'server_error' }); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin, issuer: origin, knobs, requests, publicJwk, kid,
    addClient: (c) => registry.set(c.id, c),
    requestsTo: (p) => requests.filter((r) => r.path === p),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
