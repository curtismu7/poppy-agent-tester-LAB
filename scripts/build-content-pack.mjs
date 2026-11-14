// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the app.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function buildPack() {
  const story = buildStory(DEFAULT_CAST);
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = { 'say-first': ['cimd'], discover: ['poppy-json'], signin: ['cimd', 'private-key-jwt'], call: ['poppy-session', 'delegation'], why: ['poppy-session'], unverified: ['poppy-json'], 'why-poppy': ['poppy-json'], 'value-company': ['poppy-json'], 'value-developer': ['cimd'], 'value-person': ['poppy-session'], 'value-ping': ['private-key-jwt'] };
  const tab = { 'say-first': 'run', discover: 'run', signin: 'run', call: 'run', why: 'diagram', unverified: 'run', 'why-poppy': 'why', 'value-company': 'why', 'value-developer': 'why', 'value-person': 'why', 'value-ping': 'why' };
  return {
    schema: 'demo-content-pack/1',
    id: 'poppy-agent-tester',
    title: 'Poppy Agent Tester',
    version,
    demo: { id: 'poppy-agent-tester', name: 'Poppy Agent Tester', catalog: 'D100', baseUrl: 'http://localhost:5450', doctor: '/api/health', tags: ['agent', 'poppy', 'pingfederate', 'cimd'] },
    glossary: [
      { id: 'cimd', term: 'Client metadata document (CIMD)', definition: 'A client_id that is a URL. The authorization server fetches that URL to learn the client\'s name, redirect URIs and keys, so no one has to register the client first.', aliases: ['client id metadata document'] },
      { id: 'poppy-json', term: 'poppy.json', definition: 'A public document at /.well-known/poppy.json where a Company lists its issuer, scopes (each with a scope_hint) and APIs for personal agents.', aliases: ['/.well-known/poppy.json'] },
      { id: 'private-key-jwt', term: 'private_key_jwt', definition: 'Client authentication with a signed JWT instead of a secret. PingFederate expects the header typ client-authentication+jwt and the issuer as audience.', aliases: ['client assertion'] },
      { id: 'delegation', term: 'Delegation JWT', definition: 'A JWT signed by the agent\'s published key that names a short-lived delegated key (at most 24 hours). The delegated key then signs each Poppy-Session.', aliases: ['pap_dlg'] },
      { id: 'poppy-session', term: 'Poppy-Session', definition: 'A header JWT on every request that binds the agent, the method, the URL and the access token (ath), with a one-time jti. It is separate from the access token.', aliases: ['Poppy-Session header'] },
    ],
    sources: [
      { id: 'poppy-spec', title: 'Personal Agent Protocol, Draft 0.3', url: 'https://personalagentprotocol.org/docs/introduction', kind: 'standard', use: 'Defines poppy.json, the protected-resource document and the Poppy-Session header.', status: 'read', checked: '2026-10-29' },
    ],
    cards: [
      ...story.talkTrack.map((t, i) => ({ id: `step-${t.id}`, label: t.title, description: t.say, group: 'try-it', action: { type: 'route', href: `/#${tab[t.id]}` }, terms: terms[t.id], story: sid(i + 1) })),
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.talkTrack.map((t, i) => ({ id: sid(i + 1), title: t.title, say: t.say })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
  console.log('wrote content-pack.json');
}
