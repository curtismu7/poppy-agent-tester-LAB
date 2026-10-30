import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "../api";
import Json from "./Json";

const ERR = { issuer_mismatch: "The issuer you typed is not the one the Company publishes.", hosted_simulation: "This hosted build explains and shows an example run; run the standalone to reach a real Company.", agent_not_configured: "Set PAT_AGENT_BASE_URL to the https URL PingFederate can reach, then restart.", discover_first: "Read the Company first.", sign_in_first: "Sign in first." };
// A server message that names the real values (the issuer the Company publishes, the host that failed) beats a generic one.
const say = (r) => (r.body.error === "issuer_mismatch" || r.body.error === "upstream" || r.body.error === "no_sub" ? r.body.message : ERR[r.body.error]) || r.body.message || r.body.error || `HTTP ${r.status}`;

function Step({ n, title, done, children }) {
  return (
    <section className="panel" aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`}><span className="tag">{n}</span> {title} {done && <span className="tag tag--ok">done</span>}</h2>
      {children}
    </section>
  );
}

export default function RunPanel({ info, resetSignal }) {
  const [origin, setOrigin] = useState("");
  const [issuer, setIssuer] = useState("");
  const [scope, setScope] = useState("");
  const [path, setPath] = useState("/poppy/api/v1/me");
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [last, setLast] = useState(null);
  const [sample, setSample] = useState(null);
  const [mismatch, setMismatch] = useState(null);
  const [useResource, setUseResource] = useState(false);
  useEffect(() => { if (info?.hosted) getJson("/api/sample").then(setSample, () => setSample(null)); }, [info]);

  const refresh = useCallback(() => getJson("/api/state").then((s) => {
    setState(s);
    if (s.config) { setOrigin((v) => v || s.config.origin); setIssuer((v) => v || s.config.issuer); setScope((v) => v || s.config.scope); }
  }, () => setState(null)), []);
  useEffect(() => { refresh(); }, [refresh, resetSignal]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("signin");
    if (q === "ok") setMsg("Signed in. The token below is the real one PingFederate issued.");
    else if (q === "error") setMsg("Sign-in failed. The steps below show PingFederate's answer.");
  }, []);

  const run = async (name, fn) => { setBusy(name); setMsg(""); try { await fn(); } finally { setBusy(""); await refresh(); } };
  const discover = () => run("discover", async () => {
    setMismatch(null);
    const r = await postJson("/api/discover", { origin, issuer });
    if (!r.ok) { setMismatch(r.body.discovery?.checks ?? null); return setMsg(r.status === 502 ? `Could not reach the Company or the issuer: ${r.body.message}. Check ${origin} and ${issuer}.` : say(r)); }
    const offered = Object.keys(r.body.poppy?.auth?.scopes ?? {});
    setScope(offered.includes("accounts:read") ? "accounts:read" : offered[0] ?? "");
    setMsg(r.body.ok ? "The Company's documents pass every check." : "The Company's documents have problems; see the checks.");
  });
  const signIn = () => run("authorize", async () => {
    const r = await postJson("/api/authorize", { scope, resource: useResource });
    if (!r.ok) return setMsg(say(r));
    window.location.assign(r.body.url);
  });
  const call = () => run("call", async () => {
    const r = await postJson("/api/call", { path });
    if (!r.ok) return setMsg(say(r));
    setLast(r.body);
  });

  const hosted = info?.hosted === true;
  const unknownMode = info === undefined || info === null; // until the server says live or hosted, no action is offered
  const off = hosted || unknownMode;
  const scopes = state?.discovery?.poppy?.auth?.scopes ? Object.keys(state.discovery.poppy.auth.scopes) : [];
  return (
    <div className="gate">
      {hosted && <p className="panel panel--warn">This hosted build explains the flow and shows an example run. Run the standalone on your machine to reach a real Company and a real PingFederate.</p>}
      {hosted && sample && (
        <section className="panel" aria-labelledby="example" data-testid="example-run">
          <h2 id="example">Example run</h2>
          <p className="muted">{sample.note}</p>
          <Json value={sample.steps} label="Example run steps" />
        </section>
      )}
      {info && !info.configured && !hosted && <p className="panel panel--warn" data-testid="not-configured">Sign-in and calls need PAT_AGENT_BASE_URL (the https URL PingFederate can reach for this agent). Reading the Company works without it.</p>}
      <p className="sr-only" role="status" aria-live="polite">{msg}</p>
      {msg && <p className="panel" data-testid="msg">{msg}</p>}

      <Step n={1} title="Read the Company" done={Boolean(state?.discovery)}>
        <label htmlFor="origin">Company origin</label>
        <input id="origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://company.example" spellCheck={false} autoComplete="off" />
        <label htmlFor="issuer">PingFederate issuer (must match what the Company publishes)</label>
        <input id="issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://pingfederate.example:9031" spellCheck={false} autoComplete="off" />
        <p><button type="button" onClick={discover} disabled={off || busy !== "" || !origin || !issuer} data-testid="discover">{busy === "discover" ? "Reading..." : "Read the Company"}</button></p>
        {(mismatch || state?.discovery) && (
          <ul className="facts" aria-label="Discovery checks">
            {(mismatch || state.discovery.checks).map((c) => <li key={c.id}><span className={`tag ${c.ok ? "tag--ok" : "tag--warn"}`}>{c.ok ? "pass" : c.level === "warn" ? "warn" : "fail"}</span> {c.note}</li>)}
          </ul>
        )}
      </Step>

      <Step n={2} title="Sign in as the agent" done={Boolean(state?.signedIn)}>
        <p className="muted">The agent has no registered client. Its client_id is {info?.agentClientId ? <code>{info.agentClientId}</code> : "the URL of its own metadata document"}, and PingFederate fetches that document.</p>
        <label htmlFor="scope">Scope to ask for</label>
        <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)} disabled={!scopes.length}>
          {scopes.length ? scopes.map((s) => <option key={s} value={s}>{s}</option>) : <option value="">(read the Company first)</option>}
        </select>
        <label className="inline" htmlFor="resource"><input id="resource" type="checkbox" checked={useResource} onChange={(e) => setUseResource(e.target.checked)} style={{ width: "auto", display: "inline", margin: "0 6px 0 0" }} />Send the Company as the resource (RFC 8707)</label>
        <p className="muted">Off by default: PingFederate answers 400 to a resource URI it has not registered. Turn it on for an issuer that accepts it.</p>
        <p><button type="button" onClick={signIn} disabled={off || busy !== "" || !state?.discovery || !scope} data-testid="signin">Sign in through PingFederate</button></p>
        {state?.token && (<><h3>Access token (raw, from PingFederate)</h3><Json value={state.token.access_token} label="Access token" /><h3>Decoded claims</h3><Json value={state.token.claims} label="Token claims" /></>)}
      </Step>

      <Step n={3} title="Call the Company with a Poppy-Session" done={last?.response?.status === 200}>
        <label htmlFor="path">Path on the Company origin</label>
        <input id="path" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoComplete="off" />
        <p><button type="button" onClick={call} disabled={off || busy !== "" || !state?.signedIn} data-testid="call">Call with token and Poppy-Session</button></p>
        {last && (<>
          <h3>Request</h3><Json value={last.request} label="Request" />
          <h3>Response <span className={`tag ${last.response.status === 200 ? "tag--ok" : "tag--warn"}`}>{last.response.status}</span></h3><Json value={last.response.body} label="Response" />
        </>)}
      </Step>

      <section className="panel" aria-labelledby="log">
        <h2 id="log">Every step so far</h2>
        {state?.steps?.length ? <Json value={state.steps} label="Step log" /> : <p className="muted">Nothing yet.</p>}
      </section>
    </div>
  );
}
