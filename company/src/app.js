// The reference Company: a node:http listener with the Poppy documents and one protected endpoint, GET /poppy/api/v1/me.
// It never logs and never echoes Authorization, Poppy-Session or any token text. htu is built from configuration, never from Host or X-Forwarded-*.
import { CompanyError } from './jws.js';
import { createKeyStore } from './keys.js';
import { createAccessTokenVerifier, SCOPE } from './token.js';
import { createSessionVerifier } from './poppySession.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const BEARER = /^Bearer +([^\s]+)$/i;

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res, err) {
  const headers = {};
  if (err.status === 401) headers['www-authenticate'] = `Bearer error="${err.code}"`;
  if (err.status === 403) headers['www-authenticate'] = `Bearer error="${err.code}", scope="${SCOPE}"`;
  send(res, err.status, { error: err.code, error_description: err.description, ...err.extra }, headers);
}

export const poppyDocument = (c) => ({
  protocol_version: '1.0',
  organization: { name: c.orgName, domain: new URL(c.origin).host },
  auth: {
    issuer: c.issuer,
    scopes: { [SCOPE]: "Read the signed-in user's account summary" },
    scope_hints: { [SCOPE]: { changes: 'none', personal_data: true } },
  },
  apis: [{ type: 'openapi', url: `${c.origin}/poppy/api/openapi.json`, description: 'Account summary for the signed-in user' }],
});

export const protectedResourceDocument = (c) => ({
  resource: c.origin,
  authorization_servers: [c.issuer],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
});

export const openApiDocument = (c) => ({
  openapi: '3.1.0',
  info: { title: `${c.orgName} account API`, version: '1.0.0' },
  servers: [{ url: c.origin }],
  paths: {
    '/poppy/api/v1/me': {
      get: {
        operationId: 'getMe',
        summary: "The signed-in user's account summary",
        security: [{ oauth: [SCOPE] }],
        parameters: [
          { name: 'Poppy-Session', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'Poppy-Version', in: 'header', required: true, schema: { type: 'string', pattern: '^1\\.\\d+$' } },
        ],
        responses: {
          200: { description: 'The session state, signed in when a valid access token came with the request' },
          400: { description: 'invalid_session or version_unsupported' },
          401: { description: 'invalid_token' },
          403: { description: 'insufficient_scope' },
        },
      },
    },
  },
  components: { securitySchemes: { oauth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${c.issuer}/authorize`, tokenUrl: `${c.issuer}/token`, scopes: { [SCOPE]: "Read the signed-in user's account summary" } } } } } },
});

export function createCompanyApp({ config, fetchImpl = fetch, now = () => Date.now() }) {
  const asKeys = createKeyStore({ uri: config.issuerJwksUri, kind: 'RSA', fetchImpl, allowLoopback: config.allowLoopback, now, label: 'authorization server keys' });
  const agentKeys = createKeyStore({ uri: config.agentJwksUri, kind: 'agent', fetchImpl, allowLoopback: config.allowLoopback, now, label: 'agent keys' });
  const verifyAccessToken = createAccessTokenVerifier({ config, keyStore: asKeys, now });
  const verifySession = createSessionVerifier({ config, agentKeys, now });

  const documents = {
    '/.well-known/poppy.json': { body: poppyDocument(config), cache: 'public, max-age=300' },
    '/.well-known/oauth-protected-resource': { body: protectedResourceDocument(config), cache: 'public, max-age=300' },
    '/poppy/api/openapi.json': { body: openApiDocument(config), cache: 'no-store' },
    '/healthz': { body: { ok: true }, cache: 'no-store' },
  };

  async function me(req, res, pathname) {
    // 1 and 2: the session header and the version come first, so a missing version never leaks token status.
    const session = req.headers['poppy-session'];
    if (typeof session !== 'string' || session.trim() === '') throw new CompanyError(400, 'invalid_session', 'Poppy-Session header is required');
    const version = req.headers['poppy-version'];
    if (typeof version !== 'string' || !/^1\.\d+$/.test(version.trim())) throw new CompanyError(400, 'version_unsupported', 'Poppy-Version must be 1.x');

    // 3: the bearer token, when there is one. Any other scheme (DPoP, Basic) is not a valid token.
    let bearer = null;
    let token = null;
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const m = BEARER.exec(authorization);
      if (!m) throw new CompanyError(401, 'invalid_token', 'only Bearer access tokens are accepted');
      token = await verifyAccessToken(m[1]);
      bearer = { token: m[1], clientId: token.clientId, sub: token.claims.sub };
    }

    // 4: the session.
    const verified = await verifySession({ session: session.trim(), bearer, method: req.method, pathname });
    if (!token) return send(res, 200, { state: 'signed_out', session_id: verified.sid, agent_id: verified.iss, scopes: [] });
    return send(res, 200, { state: 'signed_in', user_id: verified.sub, session_id: verified.sid, agent_id: verified.iss, scopes: token.scopes });
  }

  return async function listener(req, res) {
    try {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return send(res, 404, { error: 'not_found' });
      // The route is the raw path before the first "?", matched exactly. It is never parsed or normalized (a URL parser turns a
      // backslash into a slash and resolves dot segments), so the path that is routed and signed into htu is the one on the wire.
      const q = req.url.indexOf('?');
      const pathname = q === -1 ? req.url : req.url.slice(0, q);
      const doc = Object.hasOwn(documents, pathname) ? documents[pathname] : null;
      if (doc) return send(res, 200, doc.body, { 'cache-control': doc.cache });
      if (pathname === '/poppy/api/v1/me') return await me(req, res, pathname);
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof CompanyError) return sendError(res, err);
      return send(res, 500, { error: 'server_error' });
    }
  };
}
