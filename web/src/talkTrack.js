// The spoken story, in order. docs/talk-track.md is built from this by `npm run talk-track` (step 3).
export const TALK = [
  { id: "say-first", title: "Say this first", say: "A person's own agent can use a Company's APIs without the Company registering that agent. The agent names itself with a URL, and signs everything it sends." },
  { id: "discover", title: "Discover", say: "The agent reads two public documents from the Company: poppy.json says which scopes and APIs exist, and the protected-resource document names the authorization server. The resource must be exactly the Company origin." },
  { id: "signin", title: "Sign in", say: "There is no client id to register. The client_id is the URL of the agent's metadata document, and PingFederate fetches it. The agent proves itself with a signed assertion, not a secret." },
  { id: "call", title: "Call", say: "Each request carries the access token and a Poppy-Session. The session is signed by a short-lived key that the agent's long-lived key vouched for, and it names this method, this URL and this token." },
  { id: "why", title: "Why two headers", say: "The token says what the person allowed. The session says which agent is asking right now, for this one request. A stolen token alone is not enough." },
  { id: "unverified", title: "What we have not shown", say: "The Company's issuer metadata does not yet list protected_resources, which the spec asks for. We found no PingFederate setting for it." },
];
