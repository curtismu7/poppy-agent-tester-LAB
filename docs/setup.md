# Setup for a live run

You need three things: a PingFederate, a Company, and this app reachable over https.

1. **Company.** Any server that serves `/.well-known/poppy.json` and `/.well-known/oauth-protected-resource` with `resource` equal to its origin, and an API that checks the bearer token and the `Poppy-Session` header. AI-DEMO2 is one (its Poppy host).
2. **PingFederate.** A CIMD policy for the agent's client metadata URL (`${PAT_AGENT_BASE_URL}/client.json`), restricted to a token manager whose `client_id` comes from the request, not from a hardcoded mapping. AI-DEMO2 has `scripts/provision-poppy-pf.js` that creates exactly that (dry run by default). Traps: PingFederate allows one exact URL per CIMD policy; CIMD clients cannot use `pi.flow`; it caches CIMD clients for at least 5 minutes; the policy's token manager only applies without the `openid` scope; the client assertion header must be `client-authentication+jwt`.
3. **This app.** `PAT_AGENT_BASE_URL=https://agent.example PAT_AGENT_HOST=agent.example PAT_TLS_CERT=... PAT_TLS_KEY=... PAT_BIND=0.0.0.0 ./scripts/run.sh`. The URL must resolve to this machine from PingFederate and carry a certificate PingFederate trusts (set `NODE_EXTRA_CA_CERTS` for a local CA).

Then open the page, type the Company origin and the issuer, and go through the three steps. The Company must list the agent's `client.json` URL as an allowed agent.
