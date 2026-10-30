# Poppy Agent Tester

Tier: Demo

Plays the personal agent from the Personal Agent Protocol (Poppy, Draft 0.3). You type a Company origin and a PingFederate issuer; the app reads the Company's `poppy.json`, signs in to the real PingFederate with a URL as its client id and PKCE, and calls the Company API with a signed `Poppy-Session`. Every request, token and signature is shown raw.

**What is real and what is not.** A local run talks to the real Company and the real PingFederate you name, and to nothing else. The hosted build (SE cluster) reaches nothing: it explains the flow and shows an example run with invented values.

## Run it

```sh
./scripts/run.sh            # http://localhost:5450  (npm ci, build, doctor, start)
npm test                    # server, web and repo tests
npm run doctor              # preflight, same checks as /api/health
```

Sign-in needs a PingFederate CIMD policy for this agent and the app reachable over https: see [docs/setup.md](docs/setup.md). Docker (OrbStack): `HOST_PORT=5450 docker compose up --build -d`.

## Presenting

Press `P` for presenter mode; the simulation banner stays. The talk track is in [docs/talk-track.md](docs/talk-track.md). Brand it with `customer.config.json` (see the example) or the vertical picker.

## Safety

See [docs/safety.md](docs/safety.md). Loopback bind, same-origin writes, outbound only to the two hosts you type, secrets never returned.

## Status

Proven against a local PingFederate and a local Company that serves the Poppy documents and checks the `Poppy-Session` header. The hosted example run is invented.

**Shown as a warning, not met:** the issuer metadata does not list `protected_resources` (spec 3). PingFederate has no setting for it we could find; the discovery panel shows it as `warn`.

**Not exercised** (spec section 4 and beyond): refresh tokens, revocation, the device grant, DPoP, MCP servers. The tester does one authorization-code sign-in and one signed call at a time.
