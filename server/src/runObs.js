// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js, readers in
// runObservabilityReaders.js) is never edited here. This file holds: the one stdout line each step leaves, the events of the current run
// (kept per workspace, one run per record), and the record builder.
//
//   Mock: the hosted build runs no flow. Its example run is built once (sample.js) and each signing it really did is one event, so every
//         row is `simulated` and stamped when the builder ran; nothing else is shown (no sign-in, no issuer, no Company exists in Mock).
//   Real: each reply the lab RECEIVED is one `response` row (never `logged`), stamped when it arrived. `logged` rows come only from the
//         products' own logs, read from Elasticsearch with a read-only key; the lab's own stdout lines below are not read back.
//
// A run starts when the Company is read (step 1, before its documents can fail to arrive), or at a sign-in once the last run has ended, and
// ends at its first Company call; events outside a run are logged to stdout and kept in no record. Wording of the lines: `result=passed|stopped|unclear|no-reply` and none of the words the shared
// matchers read as a decision (refused, denied, invalid, failed, token, audience, scope, served ...); a test runs every line through classify().
import { createRunObservability } from './runObservability.js';
import { readersFromEnv } from './runObservabilityReaders.js';

export const MAX_EVENTS = 100;
const SERVICE = 'poppy-demo';
// A value that goes INTO a stdout line: only safe characters survive, so a value cannot add a fake key=value pair, a quote or a newline.
export const lineValue = (v, n = 60) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || 'unknown';
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };
export const GRACE_MS = 30_000; // how long after its last event a run's log window stays open

// One timestamped line per step: who decided and the outcome, never a token or an id.
export const decisionLine = (e) => `${e.at} ${SERVICE} step=${lineValue(e.step)} layer=${lineValue(e.layer, 12)} actor=${lineValue(e.actor, 24)} result=${e.result || RESULT[e.outcome]} mode=${lineValue(e.source, 8)}`;

// Per workspace: the events of the runs still held, the run being filled (`open`), the run whose sign-in produced the token (`tokenRun`)
// the client (id and kind) the run signs in as, and the trace id of its Company call.
export const freshObs = () => ({ events: [], n: 0, open: null, tokenRun: null, client: null, traceId: null });
// `client` is unknown until the Company's documents are read (and stays null if they never arrive).
export function startRun(obs, client = null) { obs.n += 1; obs.open = `r${obs.n}`; obs.client = client; obs.traceId = null; return obs.open; }
export const runNumber = (id) => Number(String(id ?? '').slice(1)) || 0;
const latestRun = (obs) => Math.max(0, ...obs.events.map((e) => runNumber(e.runId)));

// Stamp an event once (its time is the time of the stdout line), keep it when it belongs to a run, and bound the list: other runs go first,
// then the oldest rows of the newest run, never the one that started it. Returns the event so the caller logs the same line.
export function addEvent(obs, e, max = MAX_EVENTS) {
  const event = { ...e, at: new Date().toISOString() };
  if (!event.runId) return event;
  obs.events.push(event);
  const keepRun = latestRun(obs);
  const first = obs.events.find((x) => runNumber(x.runId) === keepRun);
  for (const guard of [(x) => runNumber(x.runId) === keepRun, (x) => x === first]) {
    for (let i = 0; i < obs.events.length && obs.events.length > max;) { if (guard(obs.events[i])) i += 1; else obs.events.splice(i, 1); }
  }
  return event;
}

// The current run: the events of the newest run still held. [] before any run.
export const currentRun = (obs) => obs.events.filter((e) => runNumber(e.runId) === latestRun(obs));

// An issuer's error redirect (RFC 6749 4.1.2.1): only these say the issuer decided no. server_error, temporarily_unavailable,
// invalid_request, unsupported_response_type and anything unknown mean it could not or would not process the request: information.
export const REFUSAL_CODES = ['access_denied', 'unauthorized_client', 'invalid_scope'];
export const redirectErrorOutcome = (code) => (REFUSAL_CODES.includes(code) ? 'refused' : 'info');

// A reply the lab received, as an outcome. OAuth endpoints (PAR, token) refuse with 400/401/403; the Company refuses with 401/403.
// Anything else, or a 2xx without a usable body, is information, never a permit.
export function replyOutcome(status, { usable, oauth = false }) {
  if (status === 401 || status === 403 || (oauth && status === 400)) return 'refused';
  return status >= 200 && status < 300 && usable ? 'allowed' : 'info';
}

const NO_AUTHORIZE = 'This lab does not call PingOne Authorize, and Authorize has no container log.';
const NO_PRIVILEGE = 'This lab does not call Privilege: it has no policy, AI Guard or approval step.';
const NO_GATEWAY = 'This lab calls no agent gateway: the agent calls the Company directly.';
const pick = (events, layer) => events.filter((e) => e.layer === layer).map(({ at, product, outcome, message, detail }) => ({ at, product, outcome, message, detail }));

const MOCK_WHY = {
  person: 'Mock mode signs nobody in: the example access token is invented and no issuer issued it, so there is no sign-in event.',
  resource: 'Mock mode contacts no Company: the example reply is an invented value, so there is no Company event.',
};

// Mock: only the events the example builder computed (all in the agent layer).
export async function buildMockRecord({ events, clock = Date.now }) {
  const layers = [
    { layer: 'person', simulated: [], reason: MOCK_WHY.person },
    { layer: 'agent', simulated: pick(events, 'agent') },
    { layer: 'authorize', simulated: [], reason: NO_AUTHORIZE },
    { layer: 'privilege', simulated: [], reason: NO_PRIVILEGE },
    { layer: 'gateway', simulated: [], reason: NO_GATEWAY },
    { layer: 'resource', simulated: [], reason: MOCK_WHY.resource },
  ];
  // No correlation ids: nothing is matched against logs in Mock, so no id is declared and names stay readable.
  return createRunObservability({ clock }).collectRun({ runId: `poppy-example-${Date.parse(events[0].at)}`, startedAt: events[0].at, endedAt: events.at(-1).at, source: 'mock', layers });
}

// Real: the current run's replies as `response` rows, plus whatever the products' own logs hold. A PingFederate sign-in is read from its
// log (CIMD client); a PingOne sign-in (a registered client) has no reader yet, so it says so.
// `kind` is the client the run signs in as: 'cimd' (PingFederate), 'registered' (PingOne) or null (the Company's documents never arrived,
// so no issuer is known and no issuer log is read).
export async function buildRealRecord({ events, kind = null, who = {}, readers = readersFromEnv(), clock = Date.now }) {
  const issuerLog = kind === 'cimd' ? ['pingfederate'] : [];
  const noReader = kind === 'registered' ? 'PingOne sign-in events are in the PingOne audit activity API, which this panel does not read yet. The reply the lab received is shown as a response row, never as logged.'
    : kind === null ? 'This run stopped before any issuer was known, so no issuer log is read for it.' : undefined;
  const layers = [
    { layer: 'person', products: issuerLog, responses: pick(events, 'person'), reason: noReader },
    { layer: 'agent', products: issuerLog, responses: pick(events, 'agent'), reason: noReader },
    { layer: 'authorize', products: [], reason: NO_AUTHORIZE },
    { layer: 'privilege', products: [], reason: NO_PRIVILEGE },
    { layer: 'gateway', products: [], reason: NO_GATEWAY },
    { layer: 'resource', products: [], responses: pick(events, 'resource'), reason: 'The Company is whichever server the visitor typed, so this lab does not know where its log lives and reads none. The reply the lab received is shown as a response row when there is one.' },
  ];
  return createRunObservability({ readers, clock }).collectRun({
    // The window ends a fixed grace after the run's last event, so reading a finished run twice searches the same window. The person's
    // sub is not declared as correlation: it is personal information and the core would keep a short one whole.
    runId: `poppy-${Date.parse(events[0].at)}`, startedAt: events[0].at, endedAt: new Date(Date.parse(events.at(-1).at) + GRACE_MS).toISOString(),
    correlation: { actClientId: who.actor, traceId: who.traceId }, layers, source: 'real',
  });
}
