// liveSequence — the run's real steps as a sequence-diagram. Pure data in, pure data out: it only reads
// what GET /api/state already returns (the same steps the Calls page rows are built from), so nothing is
// invented and nothing here makes a network call. Mirrors the role hitl-mfa's liveFlow.js plays for that
// lab's diagram: the run maps onto the picture; a step that has not run is a ghost, an error step is a
// dashed refusal.

// The lifelines, in walk order. The person and the browser are one lane: the browser carries the person's
// sign-in, and the person never talks to PingFederate directly.
const PARTICIPANTS = [
  ['person', 'Person<br/>(the user the agent acts for)'],
  ['agent', 'Agent (this lab)<br/>personal agent, CIMD client'],
  ['pf', 'PingFederate<br/>authorization server (PAR, PKCE)'],
  ['company', 'Company API<br/>poppy.json, /poppy/api/v1/me'],
];

// The chat's arrow mapping (AtlasChat STEP_ARROW) indexes PatternDiagram's 10 studio steps; this mapping
// indexes the sequence messages the same way, so a chat step lights its sequence message.
export const KIND_ORDER = ['discover', 'par', 'authorize', 'token', 'call'];

const message = (from, to, text, { dashed = false } = {}) => ({ from, to, text, dashed });

const wireOf = (s) => (s?.request ? `${s.request.method ?? 'GET'} ${shortUrl(s.request.url)}` : null);
const shortUrl = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}`; } catch { return String(u ?? ''); } };
const statusOf = (s) => (s?.response ? `HTTP ${s.response.status}` : s?.error ? `error: ${s.error}` : null);

function wireLines(step, kind) {
  if (!step) return [];
  const lines = [];
  if (wireOf(step)) lines.push({ who: 'Request', code: wireOf(step) });
  if (step.error && step.detail) lines.push({ who: 'Error', text: `${step.error}: ${step.detail}` });
  if (step.response?.status) {
    const body = step.response.body;
    lines.push({ who: 'Response', code: `HTTP ${step.response.status}${body !== undefined ? `\n${pretty(body)}` : ''}` });
  }
  return lines;
}

function pretty(v) {
  try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2); } catch { return typeof v === 'string' ? v : JSON.stringify(v); }
}

/**
 * The sequence for one run's steps, in the Calls page's row order (poppy.json, resource, PAR, authorize,
 * token, call). Each returned message carries the step kind so the page can light the one the chat just
 * drove, plus per-message reel detail built from the same live step (never invented).
 *
 * steps: /api/state's steps array. Empty state: the discovery messages still draw, as ghosts.
 */
export function buildSequence(steps = []) {
  const find = (kind) => [...steps].reverse().find((s) => s.kind === kind);
  const dStep = find('discover');
  const par = find('par');
  const auth = find('authorize');
  const tok = find('token');
  const call = find('call');

  const msgs = [];
  const push = (kind, msg, step, detail) => msgs.push({ kind, msg, step, detail });

  push('discover', message('agent', 'company', dStep ? 'GET /.well-known/poppy.json + oauth-protected-resource' : "GET the Company origin's documents"), dStep, [
    { who: 'What happens', text: 'The agent reads the Company’s two public documents: poppy.json (who the Company is, which scopes and APIs) and the protected-resource metadata (which authorization server). No identity yet.' },
    ...wireLines(dStep),
  ]);
  push('discover', message('company', 'agent', 'poppy.json: version, scopes, issuer, APIs', { dashed: true }), dStep, [
    { who: 'What happens', text: 'The documents come back. The resource document names this issuer; a token for this Company cannot be mistaken for one for another resource on the same host.' },
  ]);
  if (par) {
    push('par', message('agent', 'pf', `PAR: push the sign-in request (${wireOf(par) ?? 'private_key_jwt'})`), par, [
      { who: 'What happens', text: 'The agent pushes the whole sign-in request to PingFederate first, proving who it is with private_key_jwt. The browser later carries only client_id and a one-time request_uri.' },
      ...wireLines(par),
    ]);
    push('par', message('pf', 'agent', 'request_uri', { dashed: true }), par, [
      { who: 'What happens', text: 'A one-time request_uri comes back. Without PAR the request travels in the browser address; Companies following FAPI 2.0 require PAR.' },
    ]);
  }
  push('authorize', message('person', 'pf', auth && !auth.error ? "person signs in on the authorization server’s own page (client_id + request_uri)" : 'person signs in (in the browser)'), auth, [
    { who: 'What happens', text: "The only step the person sees: they sign in on the authorization server’s own page and allow the scope this agent asked for. With PAR the address holds just client_id and request_uri." },
    ...(auth?.error ? [{ who: 'Error', text: `${auth.error}${auth.detail ? `: ${auth.detail}` : ''}` }] : []),
  ]);
  push('token', message('agent', 'pf', tok ? `token: code + PKCE + private_key_jwt (${wireOf(tok) ?? 'POST'})` : 'token: exchange the code'), tok, [
    { who: 'What happens', text: 'The agent swaps the one-time code for tokens, proving it holds the key that matches its client.json (private_key_jwt). The client_id is the agent’s own metadata URL.' },
    ...wireLines(tok),
  ]);
  push('token', message('pf', 'agent', 'access token (client_id = agent URL)', { dashed: true }), tok, [
    { who: 'What happens', text: 'The token names the agent and the person it acts for; the Poppy-Session comes next.' },
  ]);
  push('call', message('agent', 'company', call ? `GET /poppy/api/v1/me: Bearer + Poppy-Session + Poppy-Version` : 'GET /poppy/api/v1/me'), call, [
    { who: 'What happens', text: 'The call carries the access token AND a Poppy-Session: a JWT signed for this one request by a delegated key. The token says what the person allowed; the session says which agent is asking right now, for this method, this URL and this token. A stolen token alone is not enough.' },
    ...wireLines(call),
  ]);
  push('call', message('company', 'agent', call?.response ? `200: who the agent acts for` : 'the Company verifies token + session', { dashed: true }), call, [
    { who: 'What happens', text: "The Company checks the session signature against the delegated key, the delegation against the agent’s published keys, and that the jti was never seen before. Replaying the same session, or signing it for a different token, answers 400 invalid_session." },
    ...wireLines(call),
  ]);
  return { participants: PARTICIPANTS, messages: msgs };
}

/** The sequence text (the DSL SequenceFlowDiagram parses) for one run. */
export function sequenceSource(steps = []) {
  const { messages } = buildSequence(steps);
  const out = ['autonumber', ...PARTICIPANTS.map(([id, label]) => `participant ${id} as ${label}`)];
  for (const { msg } of messages) out.push(`${msg.from}${msg.dashed ? '-->>' : '->>'}${msg.to}: ${msg.text}`);
  return `sequenceDiagram\n${out.join('\n')}\n`;
}

/** Per-message reel detail, one { what, why, request, response } per message (SequenceFlowDiagram's stepDetails). */
export function sequenceDetails(steps = []) {
  const { messages } = buildSequence(steps);
  return messages.map(({ detail }) => {
    const out = { what: '', why: '', open: '' };
    for (const l of detail) {
      if (l.who === 'What happens') out.what = l.text;
      else if (l.who === 'Why it matters') out.why = l.text;
      else if (l.who === 'Open') out.open = l.text;
      else if (l.who === 'Request') out.request = l.code;
      else if (l.who === 'Response') out.response = l.code;
      else if (l.who === 'Error') out.open = l.text;
    }
    return out;
  });
}

/** The index of the message a step kind lands on, so the chat can light the arrow it just drove (AtlasChat's STEP_ARROW analogue). */
export const KIND_MESSAGE_INDEX = (() => {
  const probe = buildSequence([{ kind: 'discover' }, { kind: 'par', request: { method: 'POST', url: 'https://pf.example/par' } }, { kind: 'authorize' }, { kind: 'token', request: { method: 'POST', url: 'https://pf.example/token' } }, { kind: 'call', request: { method: 'GET', url: 'https://company.example/poppy/api/v1/me' } }]);
  const idx = {};
  probe.messages.forEach((m, i) => { if (!(m.kind in idx)) idx[m.kind] = i; });
  return idx; // the FIRST message of each kind: the request arrow, not its reply
})();
