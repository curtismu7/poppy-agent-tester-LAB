import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson } from "../api";
import Json, { POPPY_HOT } from "./Json";
import Pager from "./run/Pager";
import IntroPage from "./run/IntroPage";
import CallsPage from "./run/CallsPage";
import TokenPage from "./run/TokenPage";
import RunObs from "./RunObs";

const ERR = { issuer_mismatch: "The issuer you typed is not the one the Company publishes.", hosted_simulation: "This hosted build explains and shows an example run; run the standalone to reach a real Company.", agent_not_configured: "Set PAT_AGENT_BASE_URL (an https URL the authorization server can reach; for a PingOne registered client http://127.0.0.1:5450 also works), then restart.", discover_first: "Read the Company first.", sign_in_first: "Sign in first." };
// A server message that names the real values (the issuer the Company publishes, the host that failed) beats a generic one.
const say = (r) => (["issuer_mismatch", "upstream", "no_sub", "par_failed"].includes(r.body.error) ? r.body.message : ERR[r.body.error]) || r.body.message || r.body.error || `HTTP ${r.status}`;

const PAGES = ["What & why", "The calls", "Token & session"];
// Coming back from the authorization server (?signin=ok|error) lands on the calls page, where the result is.
const startPage = () => (new URLSearchParams(window.location.search).get("signin") ? 2 : 1);

export default function RunPanel({ info, resetSignal }) {
  const [page, setPage] = useState(startPage);
  const [origin, setOrigin] = useState("");
  const [issuer, setIssuer] = useState("");
  const [scope, setScope] = useState("");
  const [path, setPath] = useState("/poppy/api/v1/me");
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [sample, setSample] = useState(null);
  const [mismatch, setMismatch] = useState(null);
  const [useResource, setUseResource] = useState(false);
  const [as, setAs] = useState("pf");
  useEffect(() => { if (info?.hosted) getJson("/api/sample").then(setSample, () => setSample(null)); }, [info]);

  const refresh = useCallback(() => getJson("/api/state").then((s) => {
    setState(s);
    if (s.config) { setOrigin((v) => v || s.config.origin); setIssuer((v) => v || s.config.issuer); setScope((v) => v || s.config.scope); }
    else if (info?.defaults?.origin) {
      // One-click defaults (owner rule 2026-11-14): the deployment names its own Company and issuer.
      setOrigin((v) => v || info.defaults.origin); setIssuer((v) => v || info.defaults.issuer); if (info.defaults.scope) setScope((v) => v || info.defaults.scope);
    }
  }, () => setState(null)), [info]);
  useEffect(() => { refresh(); }, [refresh, resetSignal]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("signin");
    if (q === "ok") setMsg("Signed in. The token on the last page is the real one the authorization server issued.");
    else if (q === "error") setMsg("Sign-in failed. The rows below show the authorization server's answer.");
  }, []);

  // The radio pair preselects an issuer the deployment configured; the typed value stays editable.
  const pickAs = (which) => { setAs(which); const v = which === "p1" ? info?.defaults?.p1Issuer : info?.defaults?.issuer; if (v) setIssuer(v); };

  // Each step, also a failed one, asks the run-observability panel to read again (RunObs waits ~5 s in Real for the collector).
  const [obsTick, setObsTick] = useState(0);
  const run = async (name, fn) => { setBusy(name); setMsg(""); try { await fn(); } finally { setBusy(""); setObsTick((n) => n + 1); await refresh(); } };
  const discover = () => run("discover", async () => {
    setMismatch(null);
    const r = await postJson("/api/discover", { origin, issuer });
    if (!r.ok) { setMismatch(r.body.discovery?.checks ?? null); return setMsg(r.status === 502 ? `Could not reach the Company or the issuer: ${r.body.message}. Check ${origin} and ${issuer}.` : say(r)); }
    const offered = Object.keys(r.body.poppy?.auth?.scopes ?? {});
    setScope(offered.includes("accounts:read") ? "accounts:read" : offered[0] ?? "");
    setMsg(r.body.ok ? "The Company origin's documents pass every check." : "The Company origin's documents have problems; see the checks.");
  });
  const signIn = () => run("authorize", async () => {
    const r = await postJson("/api/authorize", { scope, resource: useResource, from: "run" });
    if (!r.ok) return setMsg(say(r));
    window.location.assign(r.body.url);
  });
  const oneClick = () => run("one-click", async () => {
    const r = await postJson("/api/discover", { origin, issuer });
    if (!r.ok) { setMismatch(r.body.discovery?.checks ?? null); return setMsg(r.status === 502 ? `Could not reach the Company or the issuer: ${r.body.message}. Check ${origin} and ${issuer}.` : say(r)); }
    const offered = Object.keys(r.body.poppy?.auth?.scopes ?? {});
    const chosen = offered.includes("accounts:read") ? "accounts:read" : offered[0] ?? "";
    if (chosen) setScope(chosen);
    const a = await postJson("/api/authorize", { scope: chosen, from: "run" });
    if (!a.ok) return setMsg((r.body.ok ? "The Company origin's documents pass every check. " : "The Company origin's documents have problems; see the checks. ") + say(a));
    window.location.assign(a.body.url);
  });
  const call = (auto = false) => run("call", async () => {
    const r = await postJson("/api/call", { path });
    if (!r.ok) return setMsg(say(r));
    if (auto) setMsg("Signed in, then called the Company with the token and a fresh Poppy-Session: see the call row below.");
  });

  const hosted = info?.hosted === true;
  const unknownMode = info === undefined || info === null; // until the server says live or hosted, no action is offered
  const off = hosted || unknownMode;

  // Back from a good sign-in, make the call the person came for, once. Only when the newest step is that sign-in's
  // token, so a reload of ?signin=ok after the call does not call again.
  const autoCall = useRef(new URLSearchParams(window.location.search).get("signin") === "ok");
  useEffect(() => {
    if (!autoCall.current || off || busy || !state?.signedIn) return;
    autoCall.current = false;
    const last = state.steps?.[state.steps.length - 1];
    if (last?.kind === "token" && !last.error) call(true);
  }, [state, off, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopes = state?.discovery?.poppy?.auth?.scopes ? Object.keys(state.discovery.poppy.auth.scopes) : [];
  const notices = (
    <>
      {hosted && <p className="panel panel--warn">This hosted build explains the flow and shows an example run. Run the standalone on your machine to reach a real Company and a real authorization server.</p>}
      {hosted && sample && (
        <section className="panel" aria-labelledby="example" data-testid="example-run">
          <h2 id="example">Example run</h2>
          <p className="muted">{sample.note}</p>
          <Json value={sample.steps} label="Example run steps" hot={POPPY_HOT} />
        </section>
      )}
      {info && !info.configured && !hosted && <p className="panel panel--warn" data-testid="not-configured">Sign-in and calls need PAT_AGENT_BASE_URL (an https URL the authorization server can reach for this agent, or http://127.0.0.1:5450 for a PingOne registered client). Reading the Company works without it.</p>}
      <p className="sr-only" role="status" aria-live="polite">{msg}</p>
      {msg && <p className="panel" data-testid="msg">{msg}</p>}
    </>
  );

  const ctx = { info, state, busy, off, scopes, scope, setScope, origin, setOrigin, issuer, setIssuer, path, setPath, useResource, setUseResource, mismatch, as, pickAs, oneClick, discover, signIn, call };
  return (
    <div className="rp">
      {page === 1 && <IntroPage />}
      {page === 2 && <><CallsPage ui={notices} c={ctx} /><RunObs mode={info?.source} tick={obsTick} reset={resetSignal} /></>}
      {page === 3 && <TokenPage state={state} />}
      <Pager page={page} pages={PAGES} plainNext={page === 2} onPage={(n) => { setPage(n); window.scrollTo?.({ top: 0 }); }} />
    </div>
  );
}
