# Setup for a live run

You need three things: a PingFederate, a Company, and this app reachable over https.

1. **Company.** Any server that serves `/.well-known/poppy.json` (with `organization.domain` equal to its host and `protocol_version` 0.3) and `/.well-known/oauth-protected-resource` (with `resource` equal to its origin), and an API that checks the bearer token and the `Poppy-Session` header. It must list this agent's `client.json` URL as an allowed agent.
2. **PingFederate.** Three objects, created through the admin API or console:
   - a **JWT access token manager** of its own, with its own signing key id, whose attribute contract includes `client_id` (and `sub`), with the `client_id` claim taken from the request's `ClientId` (a CONTEXT source) rather than a hardcoded value;
   - an **access token mapping** from your login adapter to that token manager that fulfils `client_id` from `CONTEXT / ClientId` and `sub` from the adapter's username;
   - a **CIMD policy** for the agent's client metadata URL (`${PAT_AGENT_BASE_URL}/client.json`) whose default token manager is the one above, with `restrictToDefaultAccessTokenManager` on and PKCE required.

   Traps: PingFederate allows one exact URL per CIMD policy; CIMD clients cannot use `pi.flow`; it caches CIMD clients for at least 5 minutes, so policy changes take that long to show; the policy's token manager only applies when the request has no `openid` scope; the client assertion header must be `client-authentication+jwt`; the consent form has a checked scope box that must stay checked or the token has no scope; a `resource` parameter (RFC 8707) is answered with HTTP 400 unless that resource URI is registered, so the tester sends it only when you tick the box.
3. **This app.** `PAT_AGENT_BASE_URL=https://agent.example PAT_AGENT_HOST=agent.example PAT_TLS_CERT=... PAT_TLS_KEY=... PAT_BIND=0.0.0.0 ./scripts/run.sh`. The URL must resolve to this machine from PingFederate and carry a certificate PingFederate trusts (set `NODE_EXTRA_CA_CERTS` for a local CA). The public name serves only `/client.json`, `/jwks.json` and the `/cb` sign-in redirect; the page and the API stay on loopback.

Then open the page on loopback, type the Company origin and the issuer, and go through the three steps.

## Scopes the Company advertises

The Company's authorization server is the shared PingFederate, and it advertises 55 scopes that belong to several demos. This tester asks only for `accounts:read` (the default when the Company offers it). The other 54 are not Poppy offerings. Narrowing the advertised set was considered and not done: PingFederate has no scope group or virtual-issuer setting that hides scopes from its metadata, and other demos read the same metadata. The decision (2026-10-30, owner) is to keep PingFederate and document the shared set.

## The protected_resources field

PingFederate's metadata does not list `protected_resources` (spec 3.2). The Company's metadata shim adds it on the issuer's port, and the issuer string does not change.
