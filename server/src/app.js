// One Express app. /api = health, info, discover, authorize, call, state, reset. /client.json and /jwks.json are the agent's own
// identity documents (what PingFederate fetches), and /cb receives the sign-in redirect. Loopback Host check and same-origin writes.
// Outbound calls go only to the Company origin and issuer the visitor typed, and the issuer must match what the Company published.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, isLoopbackHost, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { hostedFrom, baseUrlFrom } from './config.js';
import { createSessions } from './sessions.js';
import { workspaceFrom } from './workspaces.js';
import { discover, parseOrigin, fetchIssuerMetadata, DiscoverError } from './discover.js';
import { readClipped } from './body.js';
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
import { shelfInfo } from './shelfLink.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const MAX_BODY = 16 * 1024;
// The scope to ask for by default: the Company's own accounts:read when it is advertised, else the first one listed. A Company that
// advertises many scopes (a shared authorization server) must not hand the tester an unrelated scope first.
const defaultScope = (scopes) => (scopes.includes('accounts:read') ? 'accounts:read' : scopes[0] ?? '');
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

const safePath = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(p) && !p.includes('//') && !p.split('/').includes('..');

export function createApp({ configFile = CONFIG, agent, health = createHealth({ runtime: hostedFrom() ? 'offline' : 'live' }), hosted = hostedFrom(), baseUrl = baseUrlFrom(), sessions = createSessions(), fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  // Rule 19: the mode is a mutable holder so POST /api/mode can switch at runtime. Every gate below reads
  // holder.hosted. A hosted build cannot switch to real: realAvailable is false there (no agent config), so it fails closed.
  const holder = { hosted };
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const redirectUri = () => `${baseUrl}/cb`;
  // The visitor's typed hosts are reachable only for a short window, renewed right before each call (see netguard.js).
  const reach = (...urls) => { for (const u of urls) permitHost(new URL(u).hostname); };
  const pendingByState = new Map(); // state -> workspace id, for the redirect that carries no header
  const ready = () => (agent && baseUrl ? null : 'agent_not_configured');
  const realAvailable = () => Boolean(agent && baseUrl);

  // The agent's identity documents: public, GET only.
  app.get('/client.json', (_req, res) => { if (ready()) return res.status(503).json({ error: ready() }); res.set('Cache-Control', 'no-store'); return res.json(clientMetadata({ baseUrl, redirectUri: redirectUri() })); });
  app.get('/jwks.json', (_req, res) => { if (ready()) return res.status(503).json({ error: ready() }); res.set('Cache-Control', 'no-store'); return res.json(jwksDocument(agent.publicJwk, agent.kid)); });

  // The sign-in redirect. It carries a code and a state; the state finds the workspace that started it.
  app.get('/cb', async (req, res) => {
    const ws = pendingByState.get(String(req.query.state || ''));
    pendingByState.delete(String(req.query.state || ''));
    const rec = ws && sessions.get(ws);
    if (!rec?.pending || rec.pending.state !== req.query.state) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the page.');
    const { verifier, useResource, returnTo } = rec.pending;
    rec.pending = null;
    // The sign-in redirect may land on the public agent name, which serves nothing else; send the browser back to the loopback page.
    const home = (q) => `${returnTo || ''}/?${q}`;
    // RFC 9207: if the redirect carries an iss it must be the issuer this sign-in started with (a mix-up with another server is refused),
    // and if the issuer says it always sends one, its absence is refused too.
    // A repeated or array-valued iss (?iss[]=...) is not a string and is refused, never coerced.
    const iss = req.query.iss === undefined ? undefined : (typeof req.query.iss === 'string' ? req.query.iss : null);
    if ((iss !== undefined && iss !== rec.config.issuerClaim) || (iss === undefined && rec.config.issParamRequired)) {
      sessions.log(ws, { kind: 'authorize', error: 'iss_mismatch', detail: iss === null ? 'redirect carried iss more than once or not as text' : `redirect iss ${iss === undefined ? 'missing' : iss.slice(0, 120)} does not match ${rec.config.issuerClaim}` });
      return res.redirect(home('signin=error'));
    }
    if (req.query.error) { sessions.log(ws, { kind: 'authorize', error: String(req.query.error).slice(0, 80), detail: String(req.query.error_description || '').slice(0, 200) }); return res.redirect(home('signin=error')); }
    try {
      const req2 = tokenRequest({ tokenEndpoint: rec.config.tokenEndpoint, clientId: `${baseUrl}/client.json`, issuer: rec.config.issuerClaim, kid: agent.kid, signingKey: agent.privateKey, code: String(req.query.code || ''), redirectUri: redirectUri(), verifier, resource: useResource ? rec.config.resource : undefined });
      reach(req2.url);
      const r = await fetchImpl(req2.url, { method: 'POST', headers: req2.headers, body: req2.body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const text = await readClipped(r, MAX_BODY);
      let body; try { body = JSON.parse(text); } catch { body = null; }
      sessions.log(ws, { kind: 'token', request: { method: 'POST', url: req2.url, body: req2.body }, response: { status: r.status, body: body ?? text } });
      if (r.ok && body?.access_token) rec.token = { access_token: body.access_token, scope: body.scope, expires_in: body.expires_in, claims: decodeJws(body.access_token)?.payload ?? null };
      return res.redirect(home(r.ok ? 'signin=ok' : 'signin=error'));
    } catch (e) {
      sessions.log(ws, { kind: 'token', error: e.message });
      return res.redirect(home('signin=error'));
    }
  });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  // A malformed body is a 400 in JSON, never Express's HTML error page (which carries a stack trace outside production).
  api.use((err, _req, res, next) => { if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? 'body_too_large' : 'bad_json' }); return next(); });
  api.use('/health', health.router);
  // Rule 19: runtime Mock/Real switch. Real requires the agent key and base URL (the Company + PingFederate settings);
  // a hosted build has neither, so realAvailable is false there and the build fails closed as before.
  api.post('/mode', express.json({ limit: '2kb' }), (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !['mock', 'real'].includes(b.source)) {
      return res.status(400).json({ error: 'bad_body', message: 'body must be exactly {"source": "mock" or "real"}' });
    }
    const wantHosted = b.source === 'mock';
    if (!wantHosted && !realAvailable()) {
      return res.status(409).json({ error: 'conflict', message: 'Real mode is not available: give the server the Company and PingFederate settings (agent key and base URL).' });
    }
    holder.hosted = wantHosted;
    return res.json({ source: b.source });
  });
  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ hosted: holder.hosted, simulated: holder.hosted, agentClientId: baseUrl ? `${baseUrl}/client.json` : null, configured: !ready(),
      source: holder.hosted ? 'mock' : 'real', realAvailable: realAvailable(),
      realReason: realAvailable() ? null : 'Real mode is not available: give the server the Company and PingFederate settings (agent key and base URL).' }); });
  // customer.config.json is read on every request so editing it shows up on reload (rule 12).
  api.get('/story', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(loadCast(configFile, verticalFrom(req.query.vertical))), verticals: Object.keys(VERTICALS) }); });
  // An example run (invented values, real shape): what the hosted build shows instead of reaching a real Company.
  api.get('/sample', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildSample()); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); const name = DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0]; res.json(buildDiagram(name)); });

  // Discovery needs no agent identity; sign-in and calls do (needsAgent).
  const live = (handler, { needsAgent = true } = {}) => async (req, res) => {
    if (holder.hosted) return res.status(403).json({ error: 'hosted_simulation', message: 'This hosted build explains and shows an example run. Run the standalone to reach a real Company and PingFederate.' });
    if (needsAgent && ready()) return res.status(503).json({ error: ready() });
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
    reach(origin);
    const d = await discover(origin, { fetchImpl });
    sessions.log(ws, { kind: 'discover', request: { urls: [d.poppyUrl, d.resourceUrl] }, response: { checks: d.checks } });
    const brief = { ok: false, checks: d.checks, poppy: d.poppy, resource: d.resource };
    if (!d.issuer || new URL(d.issuer).origin !== issuer) return res.status(400).json({ error: 'issuer_mismatch', message: `The Company publishes issuer ${d.issuer ?? '(none)'}, not the one you typed (${issuer}).`, published: d.issuer ?? null, discovery: brief });
    reach(issuer);
    let im;
    try { im = await fetchIssuerMetadata(d.issuer, { fetchImpl }); } catch (e) {
      return res.status(400).json({ error: 'issuer_metadata', message: `Could not read the issuer's metadata (${e.message})`, discovery: brief });
    }
    const meta = im.meta;
    if (!meta?.authorization_endpoint || !meta?.token_endpoint) return res.status(400).json({ error: 'issuer_metadata', message: `${im.url} has no authorization_endpoint and token_endpoint`, discovery: brief });
    for (const e of [meta.authorization_endpoint, meta.token_endpoint]) {
      let o = null; try { o = new URL(e).origin; } catch { /* not a URL */ }
      if (o !== issuer) return res.status(400).json({ error: 'endpoint_origin', message: 'Issuer metadata points at another origin; refused.', discovery: brief });
    }
    // protected_resources (spec 3): the issuer should list this resource. PingFederate has no setting for it, so it is shown as a warning, not hidden.
    const checks = [
      ...d.checks,
      { id: 'issuer_metadata', ok: meta.issuer === d.issuer, note: `${im.rfc8414 ? 'RFC 8414' : 'OpenID discovery'} metadata says issuer ${meta.issuer ?? 'missing'}; it must equal ${d.issuer}` },
      { id: 'protected_resources', level: 'warn', ok: Array.isArray(meta.protected_resources) && meta.protected_resources.includes(d.resource.resource), note: `issuer metadata lists protected_resources ${JSON.stringify(meta.protected_resources ?? null)}; the spec expects ${d.resource.resource} there (PingFederate has no setting for it: UNVERIFIED that clients need it)` },
    ];
    const ok = checks.every((c) => c.level === 'warn' || c.ok);
    const rec = sessions.get(ws);
    rec.config = {
      origin, issuer, issuerClaim: d.issuer, resource: d.resource.resource, issParamRequired: meta.authorization_response_iss_parameter_supported === true,
      authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, scope: defaultScope(Object.keys(d.poppy.auth?.scopes ?? {})),
    };
    rec.discovery = { ok, checks, poppy: d.poppy, resource: d.resource };
    rec.token = null;
    return res.json({ ok, checks, poppy: d.poppy, resource: d.resource, issuer: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint } });
  }, { needsAgent: false }));

  // Step 2: build the authorization URL (PKCE, state). The browser follows it; the redirect comes back to /cb.
  api.post('/authorize', live(async (ws, req, res) => {
    const rec = sessions.get(ws);
    if (!rec.config) return res.status(409).json({ error: 'discover_first' });
    const scope = String(req.body?.scope || rec.config.scope).trim();
    if (!SCOPE_RE.test(scope) || scope.length > 200) return res.status(400).json({ error: 'bad_scope' });
    const pkce = newPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    // RFC 8707 resource: opt-in. PingFederate answers 400 to a resource URI it has not registered, so it is off unless the visitor turns it on.
    const useResource = req.body?.resource === true;
    // The loopback page this came from (a loopback Host only), so the sign-in can return the browser to it.
    const host = String(req.get('host') || '');
    const returnTo = isLoopbackHost(host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')) ? `${req.protocol}://${host}` : null;
    rec.pending = { state, verifier: pkce.verifier, useResource, returnTo };
    rec.config.scope = scope;
    pendingByState.set(state, ws);
    if (pendingByState.size > 1000) pendingByState.delete(pendingByState.keys().next().value);
    const url = authorizationUrl({ authorizationEndpoint: rec.config.authorizationEndpoint, clientId: `${baseUrl}/client.json`, redirectUri: redirectUri(), scope, state, challenge: pkce.challenge, resource: useResource ? rec.config.resource : undefined });
    sessions.log(ws, { kind: 'authorize', request: { url } });
    return res.json({ url, clientId: `${baseUrl}/client.json` });
  }));

  // Step 3: call the Company with the token and a fresh Poppy-Session. The request and the response are returned raw.
  api.post('/call', live(async (ws, req, res) => {
    const rec = sessions.get(ws);
    if (!rec.token) return res.status(409).json({ error: 'sign_in_first' });
    const p = req.body?.path ?? '/poppy/api/v1/me';
    if (!safePath(p)) return res.status(400).json({ error: 'bad_path' });
    const sub = rec.token.claims?.sub;
    if (typeof sub !== 'string' || !sub) return res.status(409).json({ error: 'no_sub', message: 'The access token has no sub claim, so the Poppy-Session cannot name the user. This tester needs a JWT access token.' });
    const url = `${rec.config.origin}${p}`;
    const clientId = `${baseUrl}/client.json`;
    const delegation = signDelegation({ clientId, kid: agent.kid, signingKey: agent.privateKey, delegatedPublicJwk: rec.delegated.publicJwk });
    const session = signSession({ delegation, delegatedKey: rec.delegated, clientId, issuer: rec.config.issuerClaim, sid: rec.sid, sub, method: 'GET', url, accessToken: rec.token.access_token });
    const trace = newTrace(req.headers.traceparent);
    const tp = formatTraceparent(trace.traceId, trace.span());
    const headers = { authorization: `Bearer ${rec.token.access_token}`, 'poppy-session': session, traceparent: tp, accept: 'application/json' };
    reach(url);
    const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = await readClipped(r, MAX_BODY);
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
  // The header "Shelf" button. Before the /api 404 below, and not tied to a web build.
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
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
