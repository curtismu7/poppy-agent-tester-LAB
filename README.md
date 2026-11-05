# Poppy Agent Tester LAB

Tier: Demo

Repo: https://github.com/curtismu7/poppy-agent-tester-LAB

Plays the personal agent from the Personal Agent Protocol (Poppy, Draft 0.3). You type a Company origin and a PingFederate issuer; the app reads the Company's `poppy.json`, signs in to the real PingFederate with a URL as its client id and PKCE, and calls the Company API with a signed `Poppy-Session`. Every request, token and signature is shown raw.

**What is real and what is not.** A local run talks to the real Company and the real PingFederate you name, and to nothing else. The hosted build (SE cluster) reaches nothing: it explains the flow and shows an example run with invented values.

## Run from a clone

Prerequisites: Node 26. Docker (OrbStack) only for the Docker form.

```
git clone https://github.com/curtismu7/poppy-agent-tester-LAB.git
cd poppy-agent-tester-LAB
npm ci
npm run build
npm run doctor
npm start
```

## Ports, and what to do if the port is taken

```
Ports: poppy-agent-tester-LAB listens on 5450 (set with PORT, default 5450).
Port range for this app: 5450-5499.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5450 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
```

Other variable: `HOST_PORT=5450` (Docker host port). Keep both inside 5450-5499.

## Run it

```sh
./scripts/run.sh            # http://localhost:5450  (npm ci, build, doctor, start)
npm test                    # server, web and repo tests
npm run doctor              # preflight, same checks as /api/health
```

Sign-in needs a PingFederate CIMD policy for this agent and the app reachable over https: see [docs/setup.md](docs/setup.md). Docker (OrbStack): `HOST_PORT=5450 docker compose up --build -d`.

## Presenting

Press `P` for presenter mode; the simulation banner stays. The talk track is in [docs/talk-track.md](docs/talk-track.md). Brand it with `customer.config.json` (see the example) or the vertical picker.

## On hold: the hosted (SE) form

The `k8s/` manifests, `k8s/deploy.sh` and the `MODE=mock` hosted image form are kept but **on hold**: the SE cluster is not used until further notice (owner, 2026-10-30). The local Docker form above is the target. Nothing here deploys anywhere by itself.

## Safety

See [docs/safety.md](docs/safety.md). Loopback bind, same-origin writes, outbound only to the two hosts you type, secrets never returned.

## Status

Proven against a local PingFederate and a local Company that serves the Poppy documents and checks the `Poppy-Session` header. The hosted example run is invented.

**Shown as a warning, not met:** the issuer metadata does not list `protected_resources` (spec 3). PingFederate has no setting for it we could find; the discovery panel shows it as `warn`.

**Not exercised** (spec section 4 and beyond): refresh tokens, revocation, the device grant, DPoP, MCP servers. The tester does one authorization-code sign-in and one signed call at a time.
