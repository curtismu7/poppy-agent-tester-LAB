// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret and never touches the network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { assertBindAllowed, bindHost, portProblem, DEFAULT_PORT, PORT_MIN, PORT_MAX } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { baseUrlFrom, hostedFrom } from './config.js';
import { registeredFrom, registeredProblem } from './registered.js';

export async function runChecks({ env = process.env } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'pass' : 'fail', `v${process.versions.node} (need >= 20)`);
  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.PAT_BIND ? ' (PAT_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is inside ${PORT_MIN}-${PORT_MAX} and not reserved`);

  const base = baseUrlFrom(env);
  if (hostedFrom(env)) add('agent-url', 'info', 'hosted build: explains and shows an example run, no sign-in');
  else if (!base) add('agent-url', 'info', 'PAT_AGENT_BASE_URL is not set: the page works, but sign-in needs the agent URL PingFederate can reach');
  else if (/^https:\/\//.test(base)) add('agent-url', 'pass', `agent client_id will be ${base}/client.json`);
  else if (registeredFrom(env) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) add('agent-url', 'pass', 'registered client, http loopback (PingOne only: a PingFederate CIMD sign-in needs https)');
  else add('agent-url', 'fail', 'PAT_AGENT_BASE_URL must be https');
  const p1Problem = registeredProblem(env);
  const p1Issuer = String(env.PAT_DEMO_P1_ISSUER || '').trim();
  if (p1Problem) add('p1-client', 'fail', p1Problem);
  else if (p1Issuer && !String(env.PAT_P1_CLIENT_ID || '').trim()) add('p1-client', 'info', 'PAT_DEMO_P1_ISSUER is set but PAT_P1_CLIENT_ID is not: PingOne has no CIMD, so a PingOne sign-in needs the registered application id');
  else if (!p1Issuer && String(env.PAT_P1_CLIENT_ID || '').trim()) add('p1-client', 'info', 'PAT_P1_CLIENT_ID is set but PAT_DEMO_P1_ISSUER is not, so the client id is ignored: registered mode needs both');
  else add('p1-client', 'pass', registeredFrom(env) ? 'registered client configured for the PingOne issuer' : 'no PingOne registered client configured (PingFederate CIMD only)');

  add('diagrams', DIAGRAM_NAMES.every((n) => buildDiagram(n).steps.length > 0) ? 'pass' : 'fail', `${DIAGRAM_NAMES.length} diagram-studio/1 diagram loads and validates`);
  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve, udp send, udp connect and reverse lookup to an unlisted host (${ng.blocked}/8)` : ng.detail);
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
