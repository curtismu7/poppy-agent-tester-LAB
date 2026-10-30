// The spoken story as DATA with {{cast}} tokens, in order. Three vertical packs fill the tokens (cast.js); a test fails on any token
// a pack does not define. docs/talk-track.md and the web talk-track view are both built from this, so they cannot drift.
import { fillDeep } from './cast.js';

export const TALK_TRACK = [
  { id: 'say-first', title: 'Say this first', say: "{{castBrand}}'s customer has {{castAgentName}} of their own. The agent can use {{castBrand}}'s APIs without {{castBrand}} registering it first: it names itself with a URL and signs everything it sends." },
  { id: 'discover', title: 'Discover', say: 'The agent reads two public documents from {{castBrand}}: poppy.json says which scopes and APIs exist, such as {{castScope}}, and the protected-resource document names the authorization server. The resource must be exactly the origin.' },
  { id: 'signin', title: 'Sign in', say: 'There is no client id to register. The client_id is the URL of the agent\'s metadata document, and PingFederate fetches it. The agent proves itself with a signed assertion, not a secret. The person signs in and allows {{castScope}}.' },
  { id: 'call', title: 'Call', say: 'Each request carries the access token and a Poppy-Session. The session is signed by a short-lived key that the agent\'s long-lived key vouched for, and it names this method, this URL and this token.' },
  { id: 'why', title: 'Why two headers', say: 'The token says what the person allowed. The session says which agent is asking right now, for this one request. A stolen token alone is not enough for {{castBrand}} to accept the call.' },
  { id: 'unverified', title: 'What we have not shown', say: "The issuer metadata does not yet list protected_resources, which the spec asks for. We found no PingFederate setting for it. UNVERIFIED: that every Poppy client will accept PingFederate's metadata without it." },
];

export const buildStory = (cast) => ({ talkTrack: fillDeep(TALK_TRACK, cast), cast });

export function renderTalkTrackMarkdown(cast) {
  const t = fillDeep(TALK_TRACK, cast);
  return `# Talk track: Poppy Agent Tester\n\nBuilt from server/src/story.js by \`npm run talk-track\`. Do not edit by hand.\n\n${t.map((s) => `## ${s.title}\n\n${s.say}\n`).join('\n')}`;
}
