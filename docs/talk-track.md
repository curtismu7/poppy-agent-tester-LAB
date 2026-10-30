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

## What we have not shown

The issuer metadata does not yet list protected_resources, which the spec asks for. We found no PingFederate setting for it. UNVERIFIED: that every Poppy client will accept PingFederate's metadata without it.
