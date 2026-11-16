// One Express app. /api = health, info, discover, authorize, call, state, reset. /client.json and /jwks.json are the agent's own
// identity documents (what PingFederate fetches), and /cb receives the sign-in redirect. Loopback Host check and same-origin writes.
// Outbound calls go only to the Company origin and issuer the visitor typed, and the issuer must match what the Company published.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isLoopbackHost, isProxiedSameOrigin, makeHostCheck, makeSameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { hostedFrom, baseUrlFrom, demoDefaultsFrom, loginHintFrom } from './config.js';
import { createSessions } from './sessions.js';
import { workspaceFrom } from './workspaces.js';
import { discover, parseOrigin, fetchIssuerMetadata, DiscoverError, SUPPORTED_VERSION } from './discover.js';
import { readClipped } from './body.js';
import { newPkce, authorizationUrl, parAuthorizationUrl, parRequest, tokenRequest } from './oauth.js';
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
import { chatTurn, MAX_TEXT } from './chatAgent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const MAX_BODY = 16 * 1024;
// The scope to ask for by default: the Company's own accounts:read when it is advertised, else the first one listed. A Company that
// advertises many scopes (a shared authorization server) must not hand the tester an unrelated scope first.
const defaultScope = (scopes) => (scopes.includes('accounts:read') ? 'accounts:read' : scopes[0] ?? '');
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

const safePath = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(p) && !p.includes('//') && !p.split('/').includes('..');

export function createApp({ configFile = CONFIG, agent, health = createHealth({ runtime: hostedFrom() ? 'offline' : 'live' }), hosted = hostedFrom(), baseUrl = baseUrlFrom(), sessions = createSessions(), fetchImpl = (...a) => globalThis.fetch(...a), proxyHosts = new Set(), chat = null } = {}) {
  // Rule 19: the mode is a mutable holder so POST /api/mode can switch at runtime. Every gate below reads
  // holder.hosted. A hosted build cannot switch to real: realAvailable is false there (no agent config), so it fails closed.
  const holder = { hosted };
  const app = express();
  app.disable('x-powered-by');
  app.use(makeHostCheck(proxyHosts));
  app.use(makeSameOriginWrites(proxyHosts));
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
    const { verifier, useResource, returnTo, from } = rec.pending;
    rec.pending = null;
    // The sign-in redirect may land on the public agent name, which serves nothing else; send the browser back to the loopback page.
    // Back to the tab the sign-in started from (#chat, #run), so the person lands where they were.
    const home = (q) => `${returnTo || ''}/?${q}${from ? `#${from}` : ''}`;
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
      realReason: realAvailable() ? null : 'Real mode is not available: give the server the Company and PingFederate settings (agent key and base URL).',
      defaults: demoDefaultsFrom(),
      // The chat tab's live agent: on when the server has a model key (never returned) and the build is not hosted.
      chatAgent: chat && !holder.hosted ? { live: true, model: chat.model } : { live: false, reason: holder.hosted ? 'hosted' : 'no_key' } }); });
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
    try { return await handler(ws, req, res); } catch (e) { const f = failure(e); return res.status(f.status).json(f.body); }
  };
  const failure = (e) => (e instanceof DiscoverError ? { status: 400, body: { error: e.code, message: e.message } } : { status: 502, body: { error: 'upstream', message: String(e.message).slice(0, 200) } });

  api.get('/state', (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    const r = sessions.get(ws);
    res.json({ workspace: ws, config: r.config && { origin: r.config.origin, issuer: r.config.issuer, scope: r.config.scope, parEndpoint: r.config.parEndpoint ?? null }, discovery: r.discovery, signedIn: Boolean(r.token), token: r.token, steps: r.steps });
  });

  // Step 1: read the Company's documents. The visitor types the Company origin and the issuer; the issuer must equal what the Company publishes.
  const discoverStep = async (ws, req, res) => {
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
    // RFC 9126: the endpoint where the authorization parameters are pushed. Same-origin rule as the other two endpoints.
    const parEndpoint = typeof meta.pushed_authorization_request_endpoint === 'string' ? meta.pushed_authorization_request_endpoint : null;
    const parRequired = meta.require_pushed_authorization_requests === true;
    for (const e of [meta.authorization_endpoint, meta.token_endpoint, ...(parEndpoint ? [parEndpoint] : [])]) {
      let o = null; try { o = new URL(e).origin; } catch { /* not a URL */ }
      if (o !== issuer) return res.status(400).json({ error: 'endpoint_origin', message: 'Issuer metadata points at another origin; refused.', discovery: brief });
    }
    // protected_resources (spec 3): the issuer should list this resource. PingFederate has no setting for it, so it is shown as a warning, not hidden.
    const checks = [
      ...d.checks,
      { id: 'par', ok: Boolean(parEndpoint) || !parRequired, note: parEndpoint ? `issuer metadata lists a pushed_authorization_request_endpoint (RFC 9126)${parRequired ? ' and requires it' : ''}: the agent pushes its sign-in request there and opens the authorization endpoint with only a request_uri` : parRequired ? 'issuer metadata says PAR is required but lists no pushed_authorization_request_endpoint' : 'issuer metadata lists no pushed_authorization_request_endpoint: the sign-in request goes through the browser URL' },
      { id: 'issuer_metadata', ok: meta.issuer === d.issuer, note: `${im.rfc8414 ? 'RFC 8414' : 'OpenID discovery'} metadata says issuer ${meta.issuer ?? 'missing'}; it must equal ${d.issuer}` },
      { id: 'protected_resources', level: 'warn', ok: Array.isArray(meta.protected_resources) && meta.protected_resources.includes(d.resource.resource), note: `issuer metadata lists protected_resources ${JSON.stringify(meta.protected_resources ?? null)}; the spec expects ${d.resource.resource} there (PingFederate has no setting for it: UNVERIFIED that clients need it)` },
    ];
    const ok = checks.every((c) => c.level === 'warn' || c.ok);
    const rec = sessions.get(ws);
    rec.config = {
      origin, issuer, issuerClaim: d.issuer, resource: d.resource.resource, issParamRequired: meta.authorization_response_iss_parameter_supported === true,
      authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, parEndpoint, scope: defaultScope(Object.keys(d.poppy.auth?.scopes ?? {})),
    };
    rec.discovery = { ok, checks, poppy: d.poppy, resource: d.resource };
    rec.token = null;
    return res.json({ ok, checks, poppy: d.poppy, resource: d.resource, issuer: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint } });
  };
  api.post('/discover', live(discoverStep, { needsAgent: false }));

  // Step 2: build the authorization URL (PKCE, state). The browser follows it; the redirect comes back to /cb.
  const authorizeStep = async (ws, req, res) => {
    const rec = sessions.get(ws);
    if (!rec.config) return res.status(409).json({ error: 'discover_first' });
    const scope = String(req.body?.scope || rec.config.scope).trim();
    if (!SCOPE_RE.test(scope) || scope.length > 200) return res.status(400).json({ error: 'bad_scope' });
    const pkce = newPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    // RFC 8707 resource: opt-in. PingFederate answers 400 to a resource URI it has not registered, so it is off unless the visitor turns it on.
    const useResource = req.body?.resource === true;
    // The page this came from, so the sign-in can return the browser to it: a loopback Host directly, or the lab-proxy
    // origin when the request arrived through the family proxy (Host is the proxy's name there, X-Forwarded-Host/-Proto
    // say where the browser actually is; they are believed only for proxy hosts, never loopback — see safety.js).
    const host = String(req.get('host') || '');
    const bareHost = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    let returnTo = isLoopbackHost(bareHost) ? `${req.protocol}://${host}` : null;
    if (!returnTo && isProxiedSameOrigin(req.headers, proxyHosts)) {
      const xfHost = String(req.headers['x-forwarded-host'] || '');
      const xfProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const proxyPath = String(req.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '');
      const bHost = xfHost.split(',')[0].trim();
      if (bHost) returnTo = `${xfProto}://${bHost}${proxyPath}`;
    }
    // The page tab that started the sign-in: a short lowercase name only, used as the return fragment and nothing else.
    const from = typeof req.body?.from === 'string' && /^[a-z]{1,16}$/.test(req.body.from) ? req.body.from : null;
    rec.pending = { state, verifier: pkce.verifier, useResource, returnTo, from };
    rec.config.scope = scope;
    pendingByState.set(state, ws);
    if (pendingByState.size > 1000) pendingByState.delete(pendingByState.keys().next().value);
    const clientId = `${baseUrl}/client.json`;
    const resource = useResource ? rec.config.resource : undefined;
    const loginHint = loginHintFrom() || undefined;
    let url;
    let pushed = false;
    if (rec.config.parEndpoint) {
      // RFC 9126 (spec 4.2: SHOULD whenever the issuer lists the endpoint): push the parameters with the client assertion, then
      // open the authorization endpoint with only client_id and the request_uri. A refusal is shown, never quietly downgraded.
      const par = parRequest({ parEndpoint: rec.config.parEndpoint, clientId, issuer: rec.config.issuerClaim, kid: agent.kid, signingKey: agent.privateKey, redirectUri: redirectUri(), scope, state, challenge: pkce.challenge, resource, loginHint });
      reach(par.url);
      const r = await fetchImpl(par.url, { method: 'POST', headers: par.headers, body: par.body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const text = await readClipped(r, MAX_BODY);
      let body; try { body = JSON.parse(text); } catch { body = text; }
      sessions.log(ws, { kind: 'par', request: { method: 'POST', url: par.url, body: par.body }, response: { status: r.status, body } });
      if (!r.ok || typeof body?.request_uri !== 'string') {
        rec.pending = null; pendingByState.delete(state);
        return res.status(502).json({ error: 'par_failed', message: `The issuer refused the pushed authorization request (HTTP ${r.status}${typeof body?.error === 'string' ? `, ${body.error.slice(0, 80)}` : ''}).` });
      }
      url = parAuthorizationUrl({ authorizationEndpoint: rec.config.authorizationEndpoint, clientId, requestUri: body.request_uri });
      pushed = true;
    } else {
      url = authorizationUrl({ authorizationEndpoint: rec.config.authorizationEndpoint, clientId, redirectUri: redirectUri(), scope, state, challenge: pkce.challenge, resource, loginHint });
    }
    sessions.log(ws, { kind: 'authorize', request: { url } });
    return res.json({ url, clientId, par: pushed });
  };
  api.post('/authorize', live(authorizeStep));

  // Step 3: call the Company with the token and a fresh Poppy-Session. The request and the response are returned raw.
  const callStep = async (ws, req, res) => {
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
    const callUrl = new URL(url);
    const headers = { authorization: `Bearer ${rec.token.access_token}`, 'poppy-session': session, 'poppy-version': SUPPORTED_VERSION, traceparent: tp, accept: 'application/json', 'x-forwarded-host': callUrl.host, 'x-forwarded-proto': callUrl.protocol.replace(':', '') };
    reach(url);
    const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = await readClipped(r, MAX_BODY);
    let body; try { body = JSON.parse(text); } catch { body = text; }
    const step = { kind: 'call', request: { method: 'GET', url, headers, session: { header: decodeJws(session)?.header, payload: decodeJws(session)?.payload }, delegation: decodeJws(delegation) }, response: { status: r.status, body } };
    sessions.log(ws, step);
    return res.json({ ...step, traceId: trace.traceId });
  };
  api.post('/call', live(callStep));

  // The chat tab's live agent. Each tool runs one of the three steps above through the same handler, with the same checks and log,
  // so a chat run and a Run it run leave the same trail. The Company and issuer are the workspace's, else the deployment defaults.
  const runStep = async (handler, ws, req, body, { needsAgent = true } = {}) => {
    if (needsAgent && ready()) return { status: 503, body: { error: ready() } };
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, set() { return this; } };
    try { await handler(ws, Object.create(req, { body: { value: body, enumerable: true } }), res); } catch (e) { Object.assign(out, failure(e)); }
    return out;
  };
  const chatTool = (ws, req) => async (name, input) => {
    const rec = sessions.get(ws);
    if (name === 'read_company') {
      // The workspace's Company once discovered, else the pair typed above the chat, else the deployment defaults.
      const typed = { origin: req.body?.origin, issuer: req.body?.issuer };
      const { origin, issuer } = rec.config ?? (typed.origin && typed.issuer ? typed : demoDefaultsFrom());
      if (!origin || !issuer) return { status: 409, body: { error: 'no_company', message: 'No Company is set: type the Company origin and the PingFederate issuer above the chat, or set PAT_DEMO_COMPANY_ORIGIN and PAT_DEMO_PF_ISSUER.' } };
      return runStep(discoverStep, ws, req, { origin, issuer }, { needsAgent: false });
    }
    if (name === 'start_sign_in') return runStep(authorizeStep, ws, req, { from: 'chat' });
    if (name === 'call_company_api') return runStep(callStep, ws, req, { path: typeof input.path === 'string' ? input.path : '/poppy/api/v1/me' });
    return { status: 400, body: { error: 'unknown_tool' } };
  };
  const chatView = (rec) => rec.chatLog ?? [];
  api.get('/chat', (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    return res.json({ messages: chatView(sessions.get(ws)) });
  });
  api.post('/chat', live(async (ws, req, res) => {
    if (!chat) return res.status(503).json({ error: 'chat_not_configured', message: 'Set ANTHROPIC_API_KEY in .env and restart to talk to a live agent. The guided chat works without it.' });
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return res.status(400).json({ error: 'bad_text', message: `Send {"text": "..."} of 1 to ${MAX_TEXT} characters.` });
    // Optional: the Company origin and issuer typed above the chat (checked again by the discover step).
    for (const k of ['origin', 'issuer']) {
      const v = req.body?.[k];
      if (v !== undefined && (typeof v !== 'string' || v.length > 300)) return res.status(400).json({ error: 'bad_company', message: `${k} must be a URL of at most 300 characters.` });
    }
    const rec = sessions.get(ws);
    if (rec.chatBusy) return res.status(409).json({ error: 'busy', message: 'The agent is still answering the last message.' });
    rec.chatBusy = true;
    rec.chat ??= []; rec.chatLog ??= [];
    const before = rec.chat.length;
    try {
      const out = await chatTurn({ client: chat.client, model: chat.model, history: rec.chat, text: text.trim(), runTool: chatTool(ws, req) });
      rec.chatLog = [...rec.chatLog, { who: 'person', text: text.trim() }, { who: 'agent', text: out.reply, tools: out.tools }].slice(-40);
      return res.json({ reply: out.reply, tools: out.tools, signInUrl: out.signInUrl, messages: rec.chatLog });
    } catch (e) {
      rec.chat.length = Math.min(rec.chat.length, before); // a failed turn leaves no half-finished tool exchange behind
      const status = typeof e?.status === 'number' ? e.status : 0;
      return res.status(502).json({ error: 'model_error', message: status === 401 ? 'The model key was refused (401). Check ANTHROPIC_API_KEY.' : status === 429 ? 'The model is rate limited (429). Try again in a moment.' : `The model call failed${status ? ` (HTTP ${status})` : ''}.` });
    } finally { rec.chatBusy = false; }
  }, { needsAgent: false }));

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
