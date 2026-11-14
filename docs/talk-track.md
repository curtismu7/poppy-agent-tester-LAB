# Talk track: Poppy Agent Tester

Built from server/src/story.js by `npm run talk-track`. Do not edit by hand.

## Say this first

Fabrikam Bank's customer has a budgeting assistant of their own. The agent can use Fabrikam Bank's APIs without Fabrikam Bank registering it first: it names itself with a URL and signs everything it sends.

## Discover

The agent reads two public documents from Fabrikam Bank: poppy.json says which scopes and APIs exist, such as accounts:read, and the protected-resource document names the authorization server. The resource must be exactly the origin.

## Sign in

There is no client id to register. The client_id is the URL of the agent's metadata document, and PingFederate fetches it. The agent proves itself with a signed assertion, not a secret. The person signs in and allows accounts:read.

## Call

Each request carries the access token and a Poppy-Session. The session is signed by a short-lived key that the agent's long-lived key vouched for, and it names this method, this URL and this token.

## Why two headers

The token says what the person allowed. The session says which agent is asking right now, for this one request. A stolen token alone is not enough for Fabrikam Bank to accept the call.

## Why Poppy exists

Today a Company faces two choices for an agent at its door: block it, or let it sign in as the person and do anything they can. Blocking loses the customer who wants their agent to help; full impersonation means the Company cannot tell an agent from a person, cannot limit what it does, and gets bots clicking through pages built for people. Both sides waste effort: Companies build agent detection, agents build evasion. Poppy replaces that fight with a door both sides agree on.

## What the Company gains

Fabrikam Bank publishes one poppy.json and any agent can work with it — no per-agent integration, no client registration desk. The Company decides which scopes an agent may request (accounts:read read, writes only with the person present), which sign-ins count, and which agents are on the allow-list. Every agent visit is identified, scoped and auditable: it can see agent traffic as agent traffic across its APIs, website and company agent, instead of mistaking it for a human or losing it to a block. And because the spec builds on OAuth and HTTPS the Company already runs, adopting it changes no existing system for people.

## What the agent developer gains

One protocol instead of one integration per Company: discover poppy.json, sign in, call — the same three steps everywhere, so the second Company and the fiftieth work the same way. The person never hands the agent a password; they sign in on the Company's own page and grant a scope, which makes consent real and revocable. The agent identifies itself honestly with a URL it controls (CIMD) and signs what it sends, so it is never pretending to be a person and never needs to evade detection. And it gets efficient access — APIs and structured conversations instead of clicking through a website.

## What the person gains

Their agent gets more done, at every Company that takes part, without being handed their credentials. They choose what the agent may see and do — read accounts:read yes, move money only with them present — and they can revoke it. The Company knows exactly which agent acted and on whose behalf, so if something goes wrong there is a record instead of a mystery.

## Where Ping lands

Every step of this flow runs through identity infrastructure: PingFederate resolves the agent URL (CIMD), signs the person in, issues the token with the agent URL as client_id, and publishes the metadata the Company verifies against. The Poppy-Session is verified with the same JWKS machinery. In other words, Poppy is a new kind of traffic arriving at the front door you already own — and the demos in this family show Ping making that door work for agents without a separate stack.

## What we have not shown

The issuer metadata does not yet list protected_resources, which the spec asks for. We found no PingFederate setting for it. UNVERIFIED: that every Poppy client will accept PingFederate's metadata without it.

---

## The one-slide version

**Why Poppy:** agents are already doing tasks for people, and every one of those tasks ends at a Company. Today that meeting is all-or-nothing — block the agent, or let it impersonate the person. Poppy (Personal Agent Protocol, https://personalagentprotocol.org) is the open middle ground: a published discovery document, standard OAuth sign-in on the Company's own page, scoped consent, and a signed session naming the agent and the request on every call.

**For Companies:** one document, any agent; per-scope control; agents identified and audited as agents; built on OAuth you already run. **For agent developers:** one protocol for every Company, no password handling, honest identity. **For people:** their agent works everywhere, with consent they grant and can revoke. **For Ping:** this is agent traffic arriving at the identity front door — CIMD, token issuance, JWKS verification — that PingFederate already owns.
