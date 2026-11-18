// The calls page is a list of rows, one per request the agent makes. Each row has a fixed teaching note ("Why this call") and,
// once the step has run, the live request and response from /api/state. Pure data in, pure data out, so it is easy to test.

const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname; } catch { return String(u || ""); } };
const latest = (steps, kind) => [...(steps || [])].reverse().find((s) => s.kind === kind);
const short = (s, n = 28) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

// Rule 24b: segment decoding is the shared pane's; a segment that is not base64url JSON stays raw (the pane's null shape).
import { decodeSegment } from "../JsonPane";
const b64json = (seg) => { try { return decodeSegment(seg); } catch { return null; } };

/**
 * An application/x-www-form-urlencoded body as its fields, so a reader sees names and values instead of one escaped line.
 * The client_assertion (private_key_jwt) is opened into its header and claims; the token itself stays whole underneath.
 */
export function decodeForm(body) {
  if (typeof body !== "string") return body;
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const [h, p] = k === "client_assertion" ? v.split(".") : [];
    const header = h && b64json(h);
    const claims = p && b64json(p);
    out[k] = header && claims ? { header, claims, jwt: v } : v;
  }
  return out;
}

// A sent form body: the decoded fields open, the exact bytes on the wire one click away.
const formRequest = (body) => [
  { label: "Request: the form fields", value: decodeForm(body), decoded: true },
  { label: "Request as sent (url-encoded)", value: body },
];

// Fixed copy. An array is shown as numbered reasons, a string as prose. Full name of the protocol in teaching text.
export const WHY = {
  poppy: "The Company publishes who it is, which scopes it offers and which APIs they unlock. This is the agent's first contact: one GET, no identity yet. The document carries protocol_version; this run speaks spec 1.0, and a Company on any 1.x is compatible.",
  resource: "The protected-resource document (RFC 9728) names the authorization server and the exact resource URI. The agent now knows where to sign in, and a token for this Company cannot be mistaken for one for another resource on the same host.",
  par: [
    "The agent pushes the whole sign-in request to the authorization server first, proving who it is with its private key (private_key_jwt). The server knows which agent is asking before the person sees any page.",
    "The browser then carries only client_id and a one-time request_uri. Nothing in the browser can change the scope, the redirect address or the PKCE challenge.",
    "Companies that follow FAPI 2.0 require this (the issuer then sets require_pushed_authorization_requests). An agent that also sends DPoP lets the server bind the code to the agent's key (RFC 9449 section 10.1); this tester does not send DPoP yet.",
  ],
  authorize: "The person's browser opens the authorization server's own page, signs in and presses Allow. This is the only step the person sees. The consent is for this agent (its URL) and this scope. With PAR the address holds just client_id and request_uri; without it, every parameter travels in the address.",
  token: [
    "The agent proves it holds the private key that matches its client.json (private_key_jwt: a signed assertion, not a secret).",
    "The authorization server swaps the one-time code, with the PKCE verifier, for an access token whose client_id is the agent's URL.",
    "The consent from the previous step is bound to this exchange: the code works once, for this agent only.",
  ],
  call: [
    "The access token says the agent may act; the Poppy-Session says which agent is asking right now, for this one request.",
    "The Company checks the session signature against the delegated key, the delegation JWT against the agent's published keys, and that the jti was never seen before.",
    "Poppy-Version tells the Company which protocol version the agent speaks (1.0). Replay the same session, or sign it for a different token, and the Company answers 400 invalid_session.",
  ],
};

const tone = (status) => (status == null ? "none" : status >= 200 && status < 300 ? "ok" : "warn");

/** Rows for the calls page from the server state. `parAdvertised` decides whether the optional PAR row is listed before it has run. */
export function buildRows(state) {
  const steps = state?.steps ?? [];
  const cfg = state?.config;
  const disco = state?.discovery;
  const dStep = latest(steps, "discover");
  const par = latest(steps, "par");
  const auth = latest(steps, "authorize");
  const tok = latest(steps, "token");
  const call = latest(steps, "call");
  const origin = cfg?.origin ?? "";
  const rows = [];

  rows.push({
    id: "poppy", method: "GET", path: "/.well-known/poppy.json", status: dStep ? 200 : null, why: WHY.poppy,
    kv: origin ? [["Host", host(origin)], ["Accept", "application/json"]] : [],
    raw: disco?.poppy ? [{ label: "Response", value: disco.poppy }] : [],
  });
  rows.push({
    id: "resource", method: "GET", path: "/.well-known/oauth-protected-resource", status: dStep ? 200 : null, why: WHY.resource,
    kv: origin ? [["Host", host(origin)]] : [],
    raw: disco?.resource ? [{ label: "Response", value: disco.resource }] : [],
  });
  if (par || cfg?.parEndpoint) {
    rows.push({
      id: "par", method: "POST", path: par ? pathOf(par.request.url) : pathOf(cfg.parEndpoint), status: par?.response?.status ?? null, why: WHY.par,
      kv: par ? [["Host", host(par.request.url)], ["Content-Type", "application/x-www-form-urlencoded"]] : [],
      raw: par ? [...formRequest(par.request.body), { label: "Response", value: par.response.body }] : [],
    });
  }
  rows.push({
    id: "authorize", method: "GET", path: auth ? pathOf(auth.request.url) : "(authorization endpoint, in the browser)", status: auth ? "browser" : null, why: WHY.authorize,
    kv: auth ? [["Host", host(auth.request.url)]] : [],
    raw: auth ? [{ label: "Address the browser opened", value: auth.request.url }] : [],
  });
  rows.push({
    id: "token", method: "POST", path: tok ? pathOf(tok.request.url) : "(token endpoint) authorization_code + PKCE", status: tok?.response?.status ?? null, why: WHY.token,
    kv: tok ? [["Host", host(tok.request.url)], ["Content-Type", "application/x-www-form-urlencoded"]] : [],
    raw: tok ? [...formRequest(tok.request.body), { label: "Response", value: tok.response.body }] : [],
  });
  rows.push({
    id: "call", method: "GET", path: call ? pathOf(call.request.url) : "/poppy/api/v1/me", status: call?.response?.status ?? null, why: WHY.call,
    kv: call ? [
      ["Authorization", "Bearer <access token>"],
      ["Poppy-Session", short(call.request.headers?.["poppy-session"])],
      ["Poppy-Version", call.request.headers?.["poppy-version"]],
    ].filter(([, v]) => v) : [],
    raw: call ? [{ label: "Response", value: call.response.body }] : [],
  });
  return rows.map((r) => ({ ...r, tone: r.status === "browser" ? "none" : tone(r.status) }));
}

/** The Poppy-Session of the latest call, decoded, for the token page. */
export function latestSession(state) {
  const call = latest(state?.steps, "call");
  if (!call) return null;
  return { raw: call.request.headers?.["poppy-session"], payload: call.request.session?.payload ?? null, header: call.request.session?.header ?? null, delegation: call.request.delegation ?? null };
}
