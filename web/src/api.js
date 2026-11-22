import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// A POST returns { ok, status, body }: a 400 or 502 is data (a code and a message), not an exception.
export async function postJson(url, payload = {}) {
  const r = await workspaceFetch(url, { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);

// Rule 27: what each layer logged for this workspace's current run. The body is { record }, { record: null, message } or { error, message }
// (Rule 23), which the panel shows as it is.
export async function getRunObservability() {
  const r = await workspaceFetch("/api/run-observability", { method: "GET" });
  try { return await r.json(); } catch { return { error: "bad_response", message: `The server answered HTTP ${r.status} without JSON.` }; }
}
