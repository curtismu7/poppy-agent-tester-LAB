// Company configuration. configFrom(env) is pure: it reads only the object it is given and throws a readable Error on a bad value.
const DEFAULT_ORIGIN = 'http://127.0.0.1:5452';
const DEFAULT_AUDIENCE = 'https://company.example/poppy';
const DEFAULT_AGENT_JWKS_URI = 'http://127.0.0.1:5450/jwks.json';

export const isLoopbackHost = (hostname) => hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);

/** Returns a problem string, or null when `value` is an https URL, or an http URL on a loopback host while `allowLoopback` is on. */
export function urlProblem(value, allowLoopback) {
  let u;
  try { u = new URL(value); } catch { return 'is not a URL'; }
  if (u.username || u.password) return 'must not carry credentials';
  if (u.hash) return 'must not carry a fragment';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') {
    if (!isLoopbackHost(u.hostname)) return 'must be https (http is allowed only for loopback hosts)';
    return allowLoopback ? null : 'is http, which needs COMPANY_ALLOW_LOOPBACK=1';
  }
  return 'must be an https URL';
}

export function configFrom(env = process.env) {
  const get = (name, fallback = '') => (typeof env[name] === 'string' && env[name].trim() !== '' ? env[name].trim() : fallback);
  const fail = (message) => { throw new Error(message); };

  const origin = get('COMPANY_ORIGIN', DEFAULT_ORIGIN);
  let originUrl;
  try { originUrl = new URL(origin); } catch { fail(`COMPANY_ORIGIN is not a URL: ${origin}`); }
  if (originUrl.origin !== origin) fail(`COMPANY_ORIGIN must be a bare origin with no path, query or trailing slash (got ${origin}, expected ${originUrl.origin})`);

  const flag = get('COMPANY_ALLOW_LOOPBACK');
  if (flag !== '' && flag !== '0' && flag !== '1') fail('COMPANY_ALLOW_LOOPBACK must be 1 or 0');
  const allowLoopback = flag === '' ? isLoopbackHost(originUrl.hostname) : flag === '1';

  const checkUrl = (name, value) => { const p = urlProblem(value, allowLoopback); if (p) fail(`${name} ${p}: ${value}`); return value; };
  checkUrl('COMPANY_ORIGIN', origin);

  const portText = get('COMPANY_PORT', '5452');
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 5450 && port <= 5499)) fail(`COMPANY_PORT must be a number from 5450 to 5499 (got ${portText})`);

  const issuer = get('COMPANY_ISSUER') || fail('COMPANY_ISSUER is required (the authorization server issuer)');
  checkUrl('COMPANY_ISSUER', issuer);
  const agentClientId = get('COMPANY_AGENT_CLIENT_ID') || fail('COMPANY_AGENT_CLIENT_ID is required (the one registered client_id this Company accepts)');

  return {
    origin,
    port,
    bind: get('COMPANY_BIND', '127.0.0.1'),
    issuer,
    issuerJwksUri: checkUrl('COMPANY_ISSUER_JWKS_URI', get('COMPANY_ISSUER_JWKS_URI', `${issuer}/jwks`)),
    audience: get('COMPANY_AUDIENCE', DEFAULT_AUDIENCE),
    agentClientId,
    agentJwksUri: checkUrl('COMPANY_AGENT_JWKS_URI', get('COMPANY_AGENT_JWKS_URI', DEFAULT_AGENT_JWKS_URI)),
    allowLoopback,
    orgName: get('COMPANY_ORG_NAME', 'Reference Company'),
    clockSkewSeconds: 5,
  };
}
