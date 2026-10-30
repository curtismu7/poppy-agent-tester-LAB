// One Express app. /api = health, info, discover, authorize, call, state, reset. /client.json and /jwks.json are the agent's own
// identity documents (what PingFederate fetches), and /cb receives the sign-in redirect. Loopback Host check and same-origin writes.
// Outbound calls go only to the Company origin and issuer the visitor typed, and the issuer must match what the Company published.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { hostedFrom, baseUrlFrom } from './config.js';
import { createSessions } from './sessions.js';
import { workspaceFrom } from './workspaces.js';
import { discover, parseOrigin, DiscoverError } from './discover.js';
import { newPkce, authorizationUrl, tokenRequest } from './oauth.js';
import { clientMetadata, jwksDocument } from './agent.js';
import { signDelegation, signSession } from './poppy.js';
import { decodeJws } from './jose.js';
import { permitHost } from './netguard.js';
import { newTrace, formatTraceparent } from './trace.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { loadCast, verticalFrom, VERTICALS } from './cast.js';
import { buildStory } from './story.js';
import { buildSample } from './sample.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const MAX_BODY = 16 * 1024;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

const clip = (text) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n... (cut at ${MAX_BODY} characters)` : text);
const safePath = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(p) && !p.includes('//') && !p.split('/').includes('..');

export function createApp({ configFile = CONFIG, agent, health = createHealth(), hosted = hostedFrom(), baseUrl = baseUrlFrom(), sessions = createSessions(), fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const redirectUri = () => `${baseUrl}/cb`;
  const pendingByState = new Map(); // state -> workspace id, for the redirect that carries no header
  const ready = () => (agent && baseUrl ? null : 'agent_not_configured');

  // The agent's identity documents: public, GET only.
  app.get('/client.json', (_req, res) => { if (ready()) return res.status(503).json({ error: ready() }); res.set('Cache-Control', 'no-store'); return res.json(clientMetadata({ baseUrl, redirectUri: redirectUri() })); });
  app.get('/jwks.json', (_req, res) => { if (ready()) return res.status(503).json({ error: ready() }); res.set('Cache-Control', 'no-store'); return res.json(jwksDocument(agent.publicJwk, agent.kid)); });

  // The sign-in redirect. It carries a code and a state; the state finds the workspace that started it.
  app.get('/cb', async (req, res) => {
    const ws = pendingByState.get(String(req.query.state || ''));
    pendingByState.delete(String(req.query.state || ''));
    const rec = ws && sessions.get(ws);
    if (!rec?.pending || rec.pending.state !== req.query.state) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the page.');
    const { verifier } = rec.pending;
    rec.pending = null;
    if (req.query.error) { sessions.log(ws, { kind: 'authorize', error: String(req.query.error).slice(0, 80), detail: String(req.query.error_description || '').slice(0, 200) }); return res.redirect('/?signin=error'); }
    try {
      const req2 = tokenRequest({ tokenEndpoint: rec.config.tokenEndpoint, clientId: `${baseUrl}/client.json`, issuer: rec.config.issuer, kid: agent.kid, signingKey: agent.privateKey, code: String(req.query.code || ''), redirectUri: redirectUri(), verifier });
      const r = await fetchImpl(req2.url, { method: 'POST', headers: req2.headers, body: req2.body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const text = clip(await r.text());
      let body; try { body = JSON.parse(text); } catch { body = null; }
      sessions.log(ws, { kind: 'token', request: { method: 'POST', url: req2.url, body: req2.body }, response: { status: r.status, body: body ?? text } });
      if (r.ok && body?.access_token) rec.token = { access_token: body.access_token, scope: body.scope, expires_in: body.expires_in, claims: decodeJws(body.access_token)?.payload ?? null };
      return res.redirect(r.ok ? '/?signin=ok' : '/?signin=error');
    } catch (e) {
      sessions.log(ws, { kind: 'token', error: e.message });
      return res.redirect('/?signin=error');
    }
  });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ hosted, simulated: hosted, agentClientId: baseUrl ? `${baseUrl}/client.json` : null, configured: !ready() }); });
  // customer.config.json is read on every request so editing it shows up on reload (rule 12).
  api.get('/story', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(loadCast(configFile, verticalFrom(req.query.vertical))), verticals: Object.keys(VERTICALS) }); });
  // An example run (invented values, real shape): what the hosted build shows instead of reaching a real Company.
  api.get('/sample', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildSample()); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); const name = DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0]; res.json(buildDiagram(name)); });

  const live = (handler) => async (req, res) => {
    if (hosted) return res.status(403).json({ error: 'hosted_simulation', message: 'This hosted build explains and shows an example run. Run the standalone to reach a real Company and PingFederate.' });
    if (ready()) return res.status(503).json({ error: ready() });
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    try { return await handler(ws, req, res); } catch (e) {
      if (e instanceof DiscoverError) return res.status(400).json({ error: e.code, message: e.message });
      return res.status(502).json({ error: 'upstream', message: String(e.message).slice(0, 200) });
    }
  };

  api.get('/state', (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    const r = sessions.get(ws);
    res.json({ workspace: ws, config: r.config && { origin: r.config.origin, issuer: r.config.issuer, scope: r.config.scope }, discovery: r.discovery, signedIn: Boolean(r.token), token: r.token, steps: r.steps });
  });

  // Step 1: read the Company's documents. The visitor types the Company origin and the issuer; the issuer must equal what the Company publishes.
  api.post('/discover', live(async (ws, req, res) => {
    const { origin: typed, issuer: typedIssuer } = req.body || {};
    const origin = parseOrigin(typed);
    const issuer = parseOrigin(typedIssuer);
    permitHost(new URL(origin).hostname);
    const d = await discover(origin, { fetchImpl });
    sessions.log(ws, { kind: 'discover', request: { urls: [d.poppyUrl, d.resourceUrl] }, response: { checks: d.checks } });
    if (new URL(d.poppy.auth?.issuer || 'x:').origin !== issuer) return res.status(400).json({ error: 'issuer_mismatch', message: `The Company publishes issuer ${d.poppy.auth?.issuer}, not the one you typed.`, discovery: d });
    permitHost(new URL(issuer).hostname);
    const oidc = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const meta = oidc.ok ? await oidc.json() : null;
    if (!meta?.authorization_endpoint || !meta?.token_endpoint) return res.status(400).json({ error: 'issuer_metadata', message: `Could not read ${issuer}/.well-known/openid-configuration`, discovery: d });
    for (const e of [meta.authorization_endpoint, meta.token_endpoint]) if (new URL(e).origin !== issuer) return res.status(400).json({ error: 'endpoint_origin', message: 'Issuer metadata points at another origin; refused.' });
    const rec = sessions.get(ws);
    rec.config = { origin, issuer, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, scope: Object.keys(d.poppy.auth?.scopes ?? {})[0] ?? '' };
    rec.discovery = { ok: d.ok, checks: d.checks, poppy: d.poppy, resource: d.resource };
    rec.token = null;
    return res.json({ ok: d.ok, checks: d.checks, poppy: d.poppy, resource: d.resource, issuer: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint } });
  }));

  // Step 2: build the authorization URL (PKCE, state). The browser follows it; the redirect comes back to /cb.
  api.post('/authorize', live(async (ws, req, res) => {
    const rec = sessions.get(ws);
    if (!rec.config) return res.status(409).json({ error: 'discover_first' });
    const scope = String(req.body?.scope || rec.config.scope).trim();
    if (!SCOPE_RE.test(scope) || scope.length > 200) return res.status(400).json({ error: 'bad_scope' });
    const pkce = newPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    rec.pending = { state, verifier: pkce.verifier };
    rec.config.scope = scope;
    pendingByState.set(state, ws);
    if (pendingByState.size > 1000) pendingByState.delete(pendingByState.keys().next().value);
    const url = authorizationUrl({ authorizationEndpoint: rec.config.authorizationEndpoint, clientId: `${baseUrl}/client.json`, redirectUri: redirectUri(), scope, state, challenge: pkce.challenge });
    sessions.log(ws, { kind: 'authorize', request: { url } });
    return res.json({ url, clientId: `${baseUrl}/client.json` });
  }));

  // Step 3: call the Company with the token and a fresh Poppy-Session. The request and the response are returned raw.
  api.post('/call', live(async (ws, req, res) => {
    const rec = sessions.get(ws);
    if (!rec.token) return res.status(409).json({ error: 'sign_in_first' });
    const p = req.body?.path ?? '/poppy/api/v1/me';
    if (!safePath(p)) return res.status(400).json({ error: 'bad_path' });
    const url = `${rec.config.origin}${p}`;
    const clientId = `${baseUrl}/client.json`;
    const delegation = signDelegation({ clientId, kid: agent.kid, signingKey: agent.privateKey, delegatedPublicJwk: rec.delegated.publicJwk });
    const session = signSession({ delegation, delegatedKey: rec.delegated, clientId, issuer: rec.config.issuer, sid: rec.sid, sub: rec.token.claims?.sub ?? rec.sid, method: 'GET', url, accessToken: rec.token.access_token });
    const trace = newTrace(req.headers.traceparent);
    const tp = formatTraceparent(trace.traceId, trace.span());
    const headers = { authorization: `Bearer ${rec.token.access_token}`, 'poppy-session': session, traceparent: tp, accept: 'application/json' };
    const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = clip(await r.text());
    let body; try { body = JSON.parse(text); } catch { body = text; }
    const step = { kind: 'call', request: { method: 'GET', url, headers, session: { header: decodeJws(session)?.header, payload: decodeJws(session)?.payload }, delegation: decodeJws(delegation) }, response: { status: r.status, body } };
    sessions.log(ws, step);
    return res.json({ ...step, traceId: trace.traceId });
  }));

  api.post('/reset', (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    sessions.reset(ws);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, workspace: ws });
  });
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: 0 }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}

export function startHttpServer({ app, port, host }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.on('error', reject);
  });
}
