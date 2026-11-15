// The chat tab's live agent, driven by a scripted stand-in for the model (no real model call, no key). The tools run against a fake
// Company and a fake PingFederate on loopback, through the same handlers as the Run it tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createApp } from '../src/app.js';
import { createSessions } from '../src/sessions.js';
import { generateEs256Key, jwkThumbprint } from '../src/jose.js';
import { createHealth } from '../src/health.js';
import { chatTurn, chatConfigFrom, DEFAULT_MODEL, MAX_TURNS, TOOLS } from '../src/chatAgent.js';

const opened = [];
const listen = (app) => new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => { opened.push(s); res(s); }); });
const originOf = (s) => `http://127.0.0.1:${s.address().port}`;
const health = () => createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });

// A model stand-in: each create() call takes the next scripted reply and records what it was sent.
function scripted(replies) {
  const sent = [];
  return { sent, create: async (params) => { sent.push(structuredClone(params)); const next = replies.shift(); if (!next) throw new Error('script ran out'); return typeof next === 'function' ? next(params) : next; } };
}
const toolUse = (name, input = {}, id = `tu_${name}`) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: `Using ${name}.` }, { type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

let pf; let company; let agentKey;
before(async () => {
  const k = generateEs256Key();
  agentKey = { privateKey: k.privateKey, publicJwk: k.publicJwk, kid: jwkThumbprint(k.publicJwk) };
  const pfApp = express();
  const pfMeta = () => ({ issuer: originOf(pf), authorization_endpoint: `${originOf(pf)}/as/authorization.oauth2`, token_endpoint: `${originOf(pf)}/as/token.oauth2` });
  pfApp.get('/.well-known/oauth-authorization-server', (_q, r) => r.json(pfMeta()));
  pf = await listen(pfApp);
  const coApp = express();
  coApp.get('/.well-known/poppy.json', (_q, r) => r.json({ protocol_version: '1.0', organization: { domain: '127.0.0.1' }, auth: { issuer: originOf(pf), scopes: { 'accounts:read': 'Read accounts' } } }));
  coApp.get('/.well-known/oauth-protected-resource', (_q, r) => r.json({ resource: originOf(company), authorization_servers: [originOf(pf)] }));
  company = await listen(coApp);
  process.env.PAT_DEMO_COMPANY_ORIGIN = originOf(company);
  process.env.PAT_DEMO_PF_ISSUER = originOf(pf);
});
after(() => { for (const s of opened) s.close(); delete process.env.PAT_DEMO_COMPANY_ORIGIN; delete process.env.PAT_DEMO_PF_ISSUER; });

async function startApp(opts) {
  const s = await listen(createApp({ agent: agentKey, baseUrl: 'https://agent.example', sessions: createSessions(), health: health(), fetchImpl: (...a) => fetch(...a), ...opts }));
  const base = originOf(s);
  return {
    post: (p, body, ws = 'w1') => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': ws, origin: base }, body: JSON.stringify(body ?? {}) }),
    get: (p, ws = 'w1') => fetch(`${base}${p}`, { headers: { 'x-workspace': ws } }),
  };
}

test('info says the chat agent is off without a key, and never carries a key', async () => {
  const a = await startApp({});
  const info = await (await a.get('/api/info')).json();
  assert.deepEqual(info.chatAgent, { live: false, reason: 'no_key' });
  const r = await a.post('/api/chat', { text: 'hi' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'chat_not_configured');
});

test('the hosted build refuses the chat and says why', async () => {
  const a = await startApp({ hosted: true, chat: { client: scripted([]), model: 'm' } });
  assert.deepEqual((await (await a.get('/api/info')).json()).chatAgent, { live: false, reason: 'hosted' });
  assert.equal((await a.post('/api/chat', { text: 'hi' })).status, 403);
});

test('a chat message runs read_company through the discover handler and returns the reply', async () => {
  const client = scripted([toolUse('read_company'), say('They publish accounts:read.')]);
  const a = await startApp({ chat: { client, model: 'model-x' } });
  const info = await (await a.get('/api/info')).json();
  assert.deepEqual(info.chatAgent, { live: true, model: 'model-x' });
  assert.equal(JSON.stringify(info).includes('sk-'), false);
  const r = await a.post('/api/chat', { text: 'Do they have my size?' });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.reply, /accounts:read/);
  assert.deepEqual(b.tools, [{ name: 'read_company', status: 200 }]);
  assert.equal(b.signInUrl, null);
  // The same trail as the Run it tab: a discover step in the workspace log, the workspace now holds the Company.
  const st = await (await a.get('/api/state')).json();
  assert.equal(st.steps.at(-1).kind, 'discover');
  assert.equal(st.config.origin, originOf(company));
  // The model saw the tool result, with the real discovery in it, and the request carried the expected settings.
  const second = client.sent[1];
  const result = second.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(result.content, /"status":200/);
  assert.equal(second.model, 'model-x');
  assert.deepEqual(second.fallbacks, 'default');
  assert.deepEqual(second.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  // The conversation is kept per workspace for the page to show after the PingFederate round trip.
  const view = await (await a.get('/api/chat')).json();
  assert.deepEqual(view.messages.map((m) => m.who), ['person', 'agent']);
  assert.deepEqual((await (await a.get('/api/chat', 'other')).json()).messages, []);
});

test('start_sign_in hands the page the PingFederate URL; a call before sign-in comes back as an error result', async () => {
  const client = scripted([toolUse('call_company_api', { path: '/poppy/api/v1/me' }), toolUse('read_company'), toolUse('start_sign_in'), say('Off to PingFederate.')]);
  const a = await startApp({ chat: { client, model: 'm' } });
  const b = await (await a.post('/api/chat', { text: "Where's my order?" })).json();
  assert.deepEqual(b.tools.map((t) => [t.name, t.status]), [['call_company_api', 409], ['read_company', 200], ['start_sign_in', 200]]);
  assert.ok(b.signInUrl.startsWith(`${originOf(pf)}/as/authorization.oauth2?`));
  assert.match(b.signInUrl, /client_id=https%3A%2F%2Fagent\.example%2Fclient\.json/);
  const firstResult = client.sent[1].messages.at(-1).content[0];
  assert.equal(firstResult.is_error, true);
  assert.match(firstResult.content, /sign_in_first/);
});

test('bad input is refused before any model call, and a model failure leaves no half turn behind', async () => {
  const client = scripted([() => { const e = new Error('nope'); e.status = 401; throw e; }, say('ok')]);
  const a = await startApp({ chat: { client, model: 'm' } });
  for (const body of [{}, { text: '' }, { text: 'x'.repeat(501) }, { text: 5 }]) assert.equal((await a.post('/api/chat', body)).status, 400);
  assert.equal(client.sent.length, 0);
  const r = await a.post('/api/chat', { text: 'hi' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /401/);
  const ok = await (await a.post('/api/chat', { text: 'hi again' })).json();
  assert.equal(ok.reply, 'ok');
  // The failed turn's message is gone; the next request starts clean with one person message.
  assert.deepEqual(client.sent[1].messages, [{ role: 'user', content: 'hi again' }]);
});

test('chatTurn stops after MAX_TURNS tool rounds and on a refusal', async () => {
  const loop = scripted(Array.from({ length: MAX_TURNS }, () => toolUse('read_company')));
  const out = await chatTurn({ client: loop, model: 'm', history: [], text: 'go', runTool: async () => ({ status: 200, body: {} }) });
  assert.equal(loop.sent.length, MAX_TURNS);
  assert.equal(out.tools.length, MAX_TURNS);
  const refuse = scripted([{ stop_reason: 'refusal', content: [] }]);
  const r2 = await chatTurn({ client: refuse, model: 'm', history: [], text: 'x', runTool: async () => ({ status: 200, body: {} }) });
  assert.match(r2.reply, /cannot help/);
});

test('chat config: the key comes only from the environment, the model defaults to the current Opus', () => {
  assert.deepEqual(chatConfigFrom({}), { apiKey: null, model: DEFAULT_MODEL });
  assert.deepEqual(chatConfigFrom({ ANTHROPIC_API_KEY: ' k ', PAT_CHAT_MODEL: 'claude-sonnet-5-5' }), { apiKey: 'k', model: 'claude-sonnet-5-5' });
});
