# Safety

- Loopback bind only (`PAT_BIND` is the explicit opt-in: the container uses it, and a host run that must be reachable by PingFederate needs it). The compose file publishes `127.0.0.1` only (a test pins it).
- Host header must be a loopback name, or the one public name in `PAT_AGENT_HOST` (what PingFederate fetches `client.json` from). Writes must be same-origin.
- Netguard refuses every outbound connection (fetch, socket, DNS, UDP) except to the two hosts the visitor typed: the Company origin and the PingFederate issuer. It has a self-test, and a test asserts the guard still blocks everything else.
- The Company origin must be https (http only to loopback), with no credentials in the URL. Redirects are never followed. Responses are capped at 256 KB (discovery) and 16 KB (shown).
- The issuer the visitor types must equal the issuer the Company publishes, and the authorization and token endpoints PingFederate publishes must sit on that same origin.
- The API path for a call must start with `/`, contain no `//` and no `..`.
- Tokens are shown raw for education: the access token PingFederate issued, its claims, the Poppy-Session and the delegation. The agent's private signing key and the delegated private key are never returned, logged or put in the step log. The agent key is stored in `.data/agent-key.json` (mode 600, git-ignored).
- Hosted build (`MODE=mock`): every endpoint that would reach a real server answers 403, and the page shows an example run with invented values on `.example` hosts and throwaway keys.
- No `eval`, `Function` or `vm`. Token and response text is rendered as text only. No EC key generator that aborted on Node 20 is used; P-256 keys come from `createECDH`.
- No tenant, credential or customer identifier ships. `customer.config.json` only sets four display strings and is git-ignored.
