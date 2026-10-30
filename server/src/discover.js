// Discovery of a Company (spec 3). The only outbound calls this app makes go to the one origin the visitor typed:
// https (http only to loopback), no redirects followed, a size cap and a time cap.
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

export class DiscoverError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function parseOrigin(text) {
  let u;
  try { u = new URL(String(text)); } catch { throw new DiscoverError('bad_origin', 'Enter a full origin such as https://company.example'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new DiscoverError('bad_scheme', 'Only https is allowed (http only to loopback)');
  if (u.username || u.password) throw new DiscoverError('bad_origin', 'Credentials in the URL are not allowed');
  return u.origin;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status >= 300 && res.status < 400) throw new DiscoverError('redirect', `${url} redirected; redirects are not followed`);
  if (!res.ok) throw new DiscoverError('http', `${url} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new DiscoverError('too_large', `${url} is larger than ${MAX_BYTES} bytes`);
  try { return JSON.parse(text); } catch { throw new DiscoverError('not_json', `${url} is not JSON`); }
}

/** Read poppy.json and the protected-resource document from one origin, and check what the spec requires of them. */
export async function discover(originText, { fetchImpl = fetch } = {}) {
  const origin = parseOrigin(originText);
  const poppyUrl = `${origin}/.well-known/poppy.json`;
  const resourceUrl = `${origin}/.well-known/oauth-protected-resource`;
  const poppy = await getJson(poppyUrl, fetchImpl);
  const resource = await getJson(resourceUrl, fetchImpl);
  const checks = [
    { id: 'version', ok: typeof poppy.protocol_version === 'string', note: `protocol_version ${poppy.protocol_version ?? 'missing'}` },
    { id: 'issuer', ok: typeof poppy.auth?.issuer === 'string' && poppy.auth.issuer.startsWith('https://'), note: `issuer ${poppy.auth?.issuer ?? 'missing'}` },
    { id: 'scope_hints', ok: Object.keys(poppy.auth?.scopes ?? {}).every((s) => poppy.auth?.scope_hints?.[s]), note: 'every scope has a scope_hint' },
    { id: 'resource', ok: resource.resource === origin, note: `resource ${resource.resource ?? 'missing'} must be exactly ${origin}` },
    { id: 'authorization_servers', ok: Array.isArray(resource.authorization_servers) && resource.authorization_servers.includes(poppy.auth?.issuer), note: 'the issuer is listed as an authorization server' },
  ];
  return { origin, poppyUrl, resourceUrl, poppy, resource, checks, ok: checks.every((c) => c.ok) };
}
