// Discovery of a Company (spec 3). The only outbound calls this app makes go to the one origin the visitor typed (and the issuer it
// names): https (http only to loopback), no redirects followed, a size cap that is enforced while reading, and a time cap.
import { readCapped, BodyTooLarge } from './body.js';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
export const SUPPORTED_VERSION = '0.3';

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

export async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status >= 300 && res.status < 400) throw new DiscoverError('redirect', `${url} redirected; redirects are not followed`);
  if (!res.ok) throw new DiscoverError('http', `${url} answered ${res.status}`);
  let text;
  try { text = await readCapped(res, MAX_BYTES); } catch (e) {
    if (e instanceof BodyTooLarge) throw new DiscoverError('too_large', `${url} is larger than ${MAX_BYTES} bytes`);
    throw e;
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new DiscoverError('not_json', `${url} is not JSON`); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new DiscoverError('not_json', `${url} must be a JSON object`);
  return doc;
}

/**
 * The issuer's metadata: RFC 8414 (/.well-known/oauth-authorization-server) first, then OpenID discovery. The issuer inside it must equal
 * the issuer we were given, character for character.
 */
export async function fetchIssuerMetadata(issuer, { fetchImpl = fetch } = {}) {
  const tries = [`${issuer}/.well-known/oauth-authorization-server`, `${issuer}/.well-known/openid-configuration`];
  let last = null;
  for (const url of tries) {
    try {
      const meta = await getJson(url, fetchImpl);
      return { url, meta, rfc8414: url.endsWith('oauth-authorization-server') };
    } catch (e) { last = e; if (!(e instanceof DiscoverError) || e.code === 'too_large') throw e; }
  }
  throw last;
}

/** Read poppy.json and the protected-resource document from one origin, and check what the spec requires of them. */
export async function discover(originText, { fetchImpl = fetch } = {}) {
  const origin = parseOrigin(originText);
  const host = new URL(origin).host;
  const poppyUrl = `${origin}/.well-known/poppy.json`;
  const resourceUrl = `${origin}/.well-known/oauth-protected-resource`;
  const poppy = await getJson(poppyUrl, fetchImpl);
  const resource = await getJson(resourceUrl, fetchImpl);
  const servers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers : [];
  // auth.issuer is optional when the protected-resource document lists exactly one authorization server.
  const issuer = typeof poppy.auth?.issuer === 'string' ? poppy.auth.issuer : (servers.length === 1 ? servers[0] : undefined);
  const checks = [
    { id: 'version', ok: poppy.protocol_version === SUPPORTED_VERSION, note: `protocol_version ${poppy.protocol_version ?? 'missing'} (this tester speaks ${SUPPORTED_VERSION})` },
    { id: 'domain', ok: typeof poppy.organization?.domain === 'string' && poppy.organization.domain.toLowerCase() === host.toLowerCase(), note: `organization.domain ${poppy.organization?.domain ?? 'missing'} must equal the host ${host}` },
    { id: 'issuer', ok: typeof issuer === 'string' && issuer.startsWith('https://'), note: `issuer ${issuer ?? 'missing'}${typeof poppy.auth?.issuer === 'string' ? '' : ' (taken from the protected-resource document)'}` },
    { id: 'scope_hints', ok: Object.keys(poppy.auth?.scopes ?? {}).every((s) => poppy.auth?.scope_hints?.[s]), note: 'every scope has a scope_hint' },
    { id: 'resource', ok: resource.resource === origin, note: `resource ${resource.resource ?? 'missing'} must be exactly ${origin}` },
    { id: 'authorization_servers', ok: typeof issuer === 'string' && servers.includes(issuer), note: 'the issuer is listed as an authorization server' },
  ];
  return { origin, issuer, poppyUrl, resourceUrl, poppy, resource, checks, ok: checks.every((c) => c.ok) };
}
