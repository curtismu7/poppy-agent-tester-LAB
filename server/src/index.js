import { fileURLToPath } from 'node:url';
import path from 'node:path';
import https from 'node:https';
import fs from 'node:fs';
import { installNetguard } from './netguard.js';
import { createApp, startHttpServer } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';
import { hostedFrom, baseUrlFrom } from './config.js';
import { loadAgentKey } from './agentKey.js';

installNetguard(); // before anything else can open a socket

try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* no .env */ }

const checks = await runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[poppy-agent-tester] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const host = assertBindAllowed(bindHost(), process.env);
const dataDir = process.env.PAT_DATA_DIR || path.resolve(fileURLToPath(new URL('../../.data', import.meta.url)));
const hosted = hostedFrom(process.env);
console.log(`[poppy-agent-tester] MODE=${process.env.MODE || 'live'}${hosted ? ' (hosted: explains and shows an example run, reaches nothing)' : ' (live: reaches only the hosts you type)'}`);
const app = createApp({ agent: hosted ? null : loadAgentKey(dataDir), hosted, baseUrl: baseUrlFrom() });
const port = resolvePort();
if (process.env.PAT_TLS_CERT && process.env.PAT_TLS_KEY) {
  // PingFederate fetches the agent's client metadata over https, so the agent URL needs a certificate PF trusts.
  const server = https.createServer({ cert: fs.readFileSync(process.env.PAT_TLS_CERT), key: fs.readFileSync(process.env.PAT_TLS_KEY) }, app);
  server.listen(port, host, () => console.log(`[poppy-agent-tester] https://${host}:${port}/ (agent client_id ${baseUrlFrom() || 'not set'}/client.json)`));
} else {
  const { url } = await startHttpServer({ port, host, app });
  console.log(`[poppy-agent-tester] ${url} (${host === '127.0.0.1' || host === '::1' || host === 'localhost' ? 'loopback' : `bound to ${host}; in a container compose publishes it on 127.0.0.1 only`})`);
}
console.log(`[poppy-agent-tester] health: /api/health`);
