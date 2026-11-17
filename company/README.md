# Reference Company

A small Poppy Company for trying the Poppy Agent Tester against a real authorization server (for example PingOne). Plain Node 26, no dependencies, loopback only by default. It is a teaching reference, not a production service.

It serves `/.well-known/poppy.json`, `/.well-known/oauth-protected-resource`, `/poppy/api/openapi.json`, `/healthz` and one protected endpoint, `GET /poppy/api/v1/me`, which checks the RS256 access token (scope `accounts:read`) and the agent's `Poppy-Session` and answers `signed_in` or `signed_out`.

## Run

```
COMPANY_ISSUER=https://auth.pingone.example/ENV_ID/as \
COMPANY_AGENT_CLIENT_ID=<registered application id> \
node company/src/index.js
```

It also reads the repo `.env` (the PingOne setup script writes the values there). Defaults: `COMPANY_ORIGIN=http://127.0.0.1:5452`, `COMPANY_PORT=5452` (5450 to 5499), `COMPANY_BIND=127.0.0.1`, `COMPANY_AUDIENCE=https://company.example/poppy`, `COMPANY_AGENT_JWKS_URI=http://127.0.0.1:5450/jwks.json`, `COMPANY_ISSUER_JWKS_URI=<issuer>/jwks`.

Type the origin into the lab exactly as `COMPANY_ORIGIN` (the `htu` the lab signs must match it character for character). The issuer must equal the lab's `PAT_DEMO_P1_ISSUER`.

## Test

```
cd company && node --test test/*.test.js
```

Tests use in-process fakes on 127.0.0.1 only.

## Known limits

- The Poppy-Session `sub` is the agent's claim. The Company binds each session id to the first `sub` and the first access-token user it sees and refuses a change of either (trust on first use). It does not map `sub` to the token user beyond that, so a real Company must do its own mapping before it acts on `user_id`.
- Delegations signed with ES256 (EC P-256 key) or PS384 (RSA key, 2048 bits or more, salt length 48) are accepted. The agent JWKS may hold both kinds; keys of any other type are ignored. The Poppy-Session itself is ES256 only.
- The access-token signing keys must be RS256.
