import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// POST /api/evaluate. Returns { ok, body }: a 400 is data (a code and a detail), not an exception.
export async function evaluate(payload) {
  const r = await workspaceFetch("/api/evaluate", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);

// POST /api/scope-gate/evaluate: a v1.261027 scenario id, optionally with the visitor's own scope text.
export async function evaluateScope(payload) {
  const r = await workspaceFetch("/api/scope-gate/evaluate", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// POST /api/agentcore/evaluate: a v1.261028 scenario id.
export async function evaluateAgentcore(payload) {
  const r = await workspaceFetch("/api/agentcore/evaluate", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}
