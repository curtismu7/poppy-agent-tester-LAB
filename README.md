# Poppy Agent Tester LAB

Tier: Demo

Repo: https://github.com/curtismu7/poppy-agent-tester-LAB

Plays the personal agent from the Personal Agent Protocol (Poppy, spec 1.0). You type a Company origin and a PingFederate issuer; the app reads the Company's `poppy.json`, signs in to the real PingFederate with a URL as its client id and PKCE, and calls the Company API with a signed `Poppy-Session`. Every request, token and signature is shown raw.

**What is real and what is not.** A local run talks to the real Company and the real PingFederate you name, and to nothing else. The hosted build (SE cluster) reaches nothing: it explains the flow and shows an example run with invented values.

<!-- instructions:start -->
## Set up and run (one command)

You need a Mac or Linux terminal (on Windows, use WSL), **Docker running** or **Node 26 or newer** (`--pingone` needs Node 26), and `git` or `curl`. Nothing else, for the first run.

```sh
curl -fsSL https://raw.githubusercontent.com/curtismu7/poppy-agent-tester-LAB/main/scripts/install.sh | sh
```

The script downloads the lab to `~/poppy-agent-tester-LAB`, builds and starts it on the first free port in 5450-5499 (127.0.0.1 only, never the network), waits until it answers, and opens your browser. The first build takes a minute or two.

Stop it with `sh ~/poppy-agent-tester-LAB/scripts/install.sh --stop`. Run the same command again to update and restart.

| Option | What it does |
|---|---|
| `--mock` | The default. The explainer with an example run of invented values. No tenant, no PingFederate, no sign-in. |
| `--real` | The live run against your own Company and PingFederate (see below). |
| `--pingone` | The live run against your own PingOne environment, with the reference Company that ships in `company/`. Creates the PingOne objects for you (see below). Needs Node 26. |
| `--region R` | With `--pingone`: `com` (default), `ca`, `eu`, `com.au`, `sg` or `asia`. |
| `--demo-user` | With `--pingone`: also create one demo user with a generated password, shown once. |
| `--port N` | Use port N (5450-5499) instead of the first free one. |
| `--dir DIR` | Put the lab in DIR. |
| `--runtime docker\|node` | Force Docker or Node. By default Docker is used when it is running, and `--real` prefers Node. |
| `--no-open` | Do not open the browser. |
| `--dry-run` | Print what would run and change nothing. |

With a pipe, pass options after `sh -s --`, for example `... | sh -s -- --real`.

### The default run (mock)

This is what to hand to someone who asks for the demo. It shows the whole Personal Agent Protocol flow, the diagram, the token and session pages and a worked example, all with invented values. It never contacts a server, because there is none to contact. It cannot sign anyone in.

### A live run (`--real`)

A live run plays the agent against a real Company and a real PingFederate. Both must already exist: this lab does not create them. You need three things (details in [docs/setup.md](docs/setup.md)):

1. **A Company**: a server that serves `/.well-known/poppy.json` and `/.well-known/oauth-protected-resource`, checks the bearer token and the `Poppy-Session` header, and lists this agent's `client.json` URL as an allowed agent.
2. **A PingFederate** with its own JWT access token manager (the `client_id` claim taken from the request's `ClientId`), an access token mapping from your login adapter, and a CIMD policy for `${PAT_AGENT_BASE_URL}/client.json`, with PKCE required.
3. **The agent reachable over https** from PingFederate, with a certificate PingFederate trusts: `PAT_AGENT_BASE_URL`, `PAT_AGENT_HOST`, `PAT_TLS_CERT`, `PAT_TLS_KEY` and `PAT_BIND`.

Then run the one command with `--real`. It copies `.env.example` to `.env` the first time; fill in the values there, run it again, and type your Company origin and issuer on the page.

### A live run against PingOne (`--pingone`)

PingOne has no Client ID Metadata Document support, so here the agent signs in with a **registered client**: a PingOne application whose ID is the `client_id`, authenticated with `private_key_jwt` (the agent's key, registered inline, no client secret), PAR and PKCE. The lab ships a small **reference Company** (`company/`, plain Node, no dependencies) that serves `poppy.json`, verifies the PingOne access token and the agent's `Poppy-Session`, and answers `/poppy/api/v1/me`.

You need: Node 26, and a PingOne environment (a sandbox is best) with a **Worker** application that holds the **Environment Admin** role there (add Identity Data Admin if you want `--demo-user`). Have its **environment ID, worker client ID and worker client secret** ready. A worker that lives in another environment, for example the administrator environment, works too: run `npm run pingone:setup -- --worker-env-id <its environment ID>`.

Run `curl ... | sh -s -- --pingone`. The script asks for the three values in the terminal (the secret is not echoed, not stored, and never leaves your machine except to your PingOne tenant), then creates in your environment:

- a custom **resource** (`https://company.example/poppy`) with the scope `accounts:read`,
- an OIDC **web application** (authorization code, PKCE S256, PAR required, `PRIVATE_KEY_JWT`, the agent's public key, redirect `http://127.0.0.1:<port>/cb`),
- the **grant** of that scope to the application,
- optionally one **demo user** (`--demo-user`) with a generated password printed once.

It writes the settings to `.env` (mode 600), starts the Company on `http://127.0.0.1:5452` and the lab on the first free port, and opens the browser. Press **Start flow** and sign in as a user of that environment (PingOne shows its own sign-in page). Remove everything it created with `npm run pingone:teardown` (it asks for the worker credentials again and deletes only what it created).

What was tested: the setup script against a real PingOne environment, where it created the objects and PingOne accepted the agent's PAR push (ES256 key, `typ: JWT`, audience = the endpoint). The whole flow is also tested end to end against an in-process fake authorization server. Not yet confirmed against PingOne: the consent page for a custom scope, the token exchange and the access token's claims, and the Company's final answer.

### If something goes wrong

| Problem | Fix |
|---|---|
| "Docker is not running" | Start Docker (OrbStack or Docker Desktop) and run the command again. |
| "need Docker (running) or Node 26" | Install one of them. Node 26 is at https://nodejs.org. |
| "port N is in use" | Leave `--port` off to take the first free port, or pick another between 5450 and 5499. |
| The page does not open | Open the address the script printed, `http://localhost:<port>/`. |
| It did not start in 60 seconds | Docker: `docker logs poppy-agent-tester-lab`. Node: `~/poppy-agent-tester-LAB/.launcher.log`. |

The lab listens on 127.0.0.1 only, runs read-only with no extra privileges in Docker, and reaches only the two hosts you type. See [docs/safety.md](docs/safety.md).
<!-- instructions:end -->

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

The **Agent chat** tab is a guided script by default: chips run the real steps and the agent lines are scripted. Put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`) and it becomes a live Claude agent (`claude-opus-5-5`, `PAT_CHAT_MODEL` to change) whose three tools are the same real steps: read the Company, start the PingFederate sign-in, call the Company API. The tools take no host, so nothing the model reads can point the agent elsewhere.

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
