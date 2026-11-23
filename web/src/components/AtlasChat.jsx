// Atlas-style chat: a phone-style conversation on the left, the protocol arrows it caused on the right.
// Two modes. With a model key on the server (info.chatAgent.live) the agent is Claude: the person types, and the agent's tools are
// the same real steps as the Run it tab. Without one it is a guided script: the chips run those steps and the agent lines are
// scripted sentences filled with what the real requests returned. Either way every arrow on the right is a real request.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../api";
import Json, { POPPY_HOT } from "./Json";
import PatternDiagram from "./PatternDiagram";
import { markEdges } from "../hooks/useDiagramStepper";

const SPEC = "https://personalagentprotocol.org/docs/1.0/spec";

// The arrow each protocol step highlights on the diagram (indexes into the poppy-flow edges, in order).
// discover 0-1, PAR 2-3, the person's sign-in 4-5, the token 6-7, the call 8-9.
export const STEP_ARROW = { discover: 0, authorize: 4, token: 7, call: 8 };
export const ARROW_VERIFIED = 9; // the Company's answer to the call
// The live agent's tools light the same arrows as the guided chips.
export const TOOL_ARROW = { read_company: STEP_ARROW.discover, start_sign_in: STEP_ARROW.authorize, call_company_api: ARROW_VERIFIED };

const GREETING_LIVE = "Hi, I'm your personal agent, running on Claude. Ask me about the Company: what's in stock, or where your order is. Every request I make shows up on the right.";
const GREETING_GUIDED = "Hi, I'm your personal agent. Pick a question below and I'll make the real requests to answer it; each one shows up on the right.";

// One scripted conversation line per real step kind. personLine is what the user "said"; agentLine is what
// the agent answers once the step completes. They reference real values from the run, never invented ones.
const SCRIPT = {
  discover: {
    person: "Do they have my size in stock?",
    agentLine: (state) => `Found them. I read ${host(state?.config?.origin)}'s documents: ${scopeSummary(state)}, sign-in at ${host(state?.config?.issuer) || "the issuer it names"}.`,
    need: "You asked about stock. Reading the Company origin's documents first.",
  },
  authorize: {
    person: "Where's my order?",
    agentLine: () => "To see your orders I need you signed in. The authorization server opens its own page; you sign in there and allow the read.",
    need: "That needs your sign-in. Opening the authorization server's page.",
  },
  token: {
    person: "(signed in at the authorization server)",
    agentLine: (state) => `Signed in. The token's client_id is my own metadata URL${state?.token?.claims?.sub ? `, and it names you as ${state.token.claims.sub}` : ""}.`,
  },
  call: {
    person: "So — where is it?",
    agentLine: (state, last) => lastCallLine(state, last),
  },
};

function host(u) { try { return new URL(u).host; } catch { return u || ""; } }
function scopeNames(state) { return Object.keys(state?.discovery?.poppy?.auth?.scopes ?? {}); }
// A chat-sized summary: the count, plus the scope this run asks for (or the first three). The full list is in the step's JSON.
export function scopeSummary(state) {
  const all = scopeNames(state);
  if (!all.length) return "no scopes published";
  const want = state?.config?.scope;
  const shown = all.includes(want) ? [want] : all.slice(0, 3);
  const rest = all.length - shown.length;
  return `${all.length} scope${all.length === 1 ? "" : "s"} (${shown.join(", ")}${rest ? ` and ${rest} more` : ""})`;
}
function lastCallLine(state, last) {
  const b = last?.response?.body;
  if (last?.response?.status === 200 && b && typeof b === "object") {
    return `Here it is: user ${b.user_id ?? b.sub ?? "you"}, session ${b.session_id ?? ""}, scopes ${(b.scopes ?? []).join(", ")}. HTTP 200.`;
  }
  return `The Company answered ${last?.response?.status ?? "?"}. The raw request and response are on the right.`;
}

function ArrowGlyph({ dir }) {
  return <span className={`atlas-arrow ${dir === "in" ? "atlas-arrow--in" : ""}`} aria-hidden>{dir === "in" ? "⇠" : "⇢"}</span>;
}

function StepRow({ step, onOpen, open }) {
  const kind = step.kind;
  const title = {
    discover: "Read the Company origin's documents",
    authorize: "Sign in at the authorization server (PKCE; client_id is the agent URL, or a registered id for PingOne)",
    token: "Exchange the code (private_key_jwt)",
    call: "Call the Company origin's API with Bearer + Poppy-Session",
  }[kind] ?? kind;
  const specSection = { discover: "#discovery", authorize: "#oauth-server", token: "#session-header", call: "#session-header" }[kind] ?? "";
  const result = step.response
    ? step.response.status
      ? `HTTP ${step.response.status}`
      : "checks shown"
    : step.error
      ? `error: ${step.error}`
      : "";
  const detail = step.response ?? step.request ?? step;
  return (
    <li className="atlas-step" data-testid={`atlas-step-${kind}`}>
      <button type="button" className="atlas-step__row" aria-expanded={open} onClick={onOpen}>
        <span className={`atlas-dot atlas-dot--${step.error ? "err" : "ok"}`} aria-hidden />
        <span className="atlas-step__title">{title}</span>
        <ArrowGlyph dir={step.response ? "in" : "out"} />
        <span className="atlas-step__result">{result}</span>
        <a className="atlas-step__spec" href={`${SPEC}${specSection}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>spec{specSection.replace("#", " §")}</a>
      </button>
      {open && <Json value={detail} label={`${title} detail`} testId={`atlas-detail-${kind}`} hot={POPPY_HOT} />}
    </li>
  );
}

export default function AtlasChat({ info, resetSignal }) {
  // Drag the divider to resize the chat panel; the width persists.
  const onHandleDown = useCallback((e) => {
    e.preventDefault();
    const grid = e.target.closest(".atlas");
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const move = (ev) => {
      ev.preventDefault();
      const w = Math.min(Math.max(ev.clientX - rect.left, 240), rect.width * 0.5);
      grid.style.setProperty("--phone-w", `${w}px`);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        const w = parseFloat(getComputedStyle(grid).getPropertyValue("--phone-w"));
        if (w) localStorage.setItem("pv.chatW", String(w));
      } catch { /* none */ }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }, []);
  useEffect(() => {
    try {
      const w = parseFloat(localStorage.getItem("pv.chatW"));
      if (w) document.querySelector(".atlas")?.style.setProperty("--phone-w", `${w}px`);
    } catch { /* none */ }
  }, []);
  const [origin, setOrigin] = useState("");
  const [issuer, setIssuer] = useState("");
  const [state, setState] = useState(null);
  const [last, setLast] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | discover | signin | call | signed-in | done
  const [chat, setChat] = useState([]); // {who:'person'|'agent', text}
  const [openStep, setOpenStep] = useState(null);
  const [msg, setMsg] = useState("");
  const [activeArrow, setActiveArrow] = useState(-1);
  const [diagram, setDiagram] = useState(null);
  const chatEnd = useRef(null);
  const live = Boolean(info?.chatAgent?.live);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { getJson("/api/diagram?name=poppy-flow").then(setDiagram, () => setDiagram(null)); }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  const refresh = useCallback(() => getJson("/api/state").then((s) => {
    setState(s);
    if (s.config) { setOrigin((v) => v || s.config.origin); setIssuer((v) => v || s.config.issuer); }
    // Same one-click defaults as the Run it tab: the deployment names its own Company and issuer.
    else if (info?.defaults?.origin) { setOrigin((v) => v || info.defaults.origin); setIssuer((v) => v || info.defaults.issuer); }
    // A workspace with real progress resumes the conversation where it is; an untouched one stays idle.
    setPhase((p) => (p === "idle" && s.discovery ? (s.signedIn ? "signed-in" : "discovered") : p));
    return s;
  }, () => { setState(null); return null; }), [info]);
  useEffect(() => { refresh(); }, [refresh, resetSignal]);
  // Live mode: the conversation lives on the server (per workspace), so it survives the round trip to the authorization server.
  useEffect(() => { if (live) getJson("/api/chat").then((r) => setChat(r.messages ?? []), () => {}); else setChat([]); }, [live, resetSignal]);

  const say = (who, text) => setChat((c) => [...c, { who, text }]);

  const send = async (text) => {
    const t = text.trim();
    if (!t || busy) return;
    setMsg(""); setBusy(true); setDraft("");
    setChat((c) => [...c, { who: "person", text: t }]);
    // Before the Company is read, the agent reads the one typed above the chat.
    const company = !state?.discovery && origin.trim() && issuer.trim() ? { origin: origin.trim(), issuer: issuer.trim() } : {};
    const r = await postJson("/api/chat", { text: t, ...company });
    setBusy(false);
    await refresh();
    if (!r.ok) { setChat((c) => c.slice(0, -1)); setDraft(t); setMsg(r.body.message ?? r.body.error ?? `HTTP ${r.status}`); return; }
    setChat(r.body.messages ?? []);
    const lastTool = [...(r.body.tools ?? [])].reverse().find((x) => x.name in TOOL_ARROW);
    if (lastTool) setActiveArrow(TOOL_ARROW[lastTool.name]);
    if (r.body.signInUrl) window.location.assign(r.body.signInUrl);
  };
  const ready = info && !info.hosted;
  const scopes = scopeNames(state);
  const signedIn = Boolean(state?.signedIn);

  const steps = useMemo(() => (state?.steps ?? []).filter((s) => ["discover", "authorize", "token", "call"].includes(s.kind)), [state]);

  const highlight = (kind) => setActiveArrow(kind in STEP_ARROW ? STEP_ARROW[kind] : -1);

  const runDiscover = async () => {
    setMsg(""); setPhase("discover"); highlight("discover");
    say("person", SCRIPT.discover.person);
    const r = await postJson("/api/discover", { origin: origin.trim(), issuer: issuer.trim() });
    const fresh = await refresh();
    if (!r.ok) { setPhase("idle"); setMsg(r.body.message ?? r.body.error ?? `HTTP ${r.status}`); say("agent", "I could not read that Company origin. Check the Company origin and the issuer above the chat."); return; }
    setActiveArrow(0);
    say("agent", SCRIPT.discover.agentLine(fresh));
    setPhase("discovered");
  };

  const runSignIn = async () => {
    setMsg(""); setPhase("signin"); highlight("authorize");
    say("person", SCRIPT.authorize.person);
    say("agent", SCRIPT.authorize.need);
    const r = await postJson("/api/authorize", { from: "chat" });
    if (!r.ok) { setPhase(scopes.length ? "discovered" : "idle"); setMsg(r.body.message ?? r.body.error ?? `HTTP ${r.status}`); return; }
    window.location.assign(r.body.url);
  };

  const runCall = async () => {
    setMsg(""); setPhase("call"); highlight("call");
    say("person", SCRIPT.call.person);
    const r = await postJson("/api/call", { path: "/poppy/api/v1/me" });
    await refresh();
    if (!r.ok) { setPhase(signedIn ? "signed-in" : "idle"); setMsg(r.body.message ?? r.body.error ?? `HTTP ${r.status}`); return; }
    setLast(r.body);
    setActiveArrow(ARROW_VERIFIED);
    say("agent", SCRIPT.call.agentLine(state, r.body));
    setPhase("done");
  };

  // After the redirect back from the authorization server the workspace already holds the token.
  useEffect(() => {
    if (state?.signedIn && phase === "signin") {
      setActiveArrow(STEP_ARROW.token);
      say("agent", SCRIPT.token.agentLine(state));
      setPhase("signed-in");
    }
  }, [state?.signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = [];
  if (live) {
    // Suggestions only: the person can type anything.
    const ask = (label) => chips.push({ label, onClick: () => send(label), disabled: busy });
    if (!state?.discovery) ask("Do they have my size in stock?");
    else if (!signedIn) ask("Where's my order?");
    else ask("I'm signed in. So, where is it?");
  }
  else if (phase === "idle") {
    if (origin.trim() && issuer.trim()) chips.push({ label: "Do they have my size in stock?", onClick: runDiscover });
    // else: the hint below says to fill the two boxes above it
  }
  else if (phase === "discovered" && !signedIn) chips.push({ label: "Where's my order?", onClick: runSignIn, disabled: !info?.configured });
  else if (phase === "signed-in") chips.push({ label: "So — where is it?", onClick: runCall });
  else if (phase === "done") chips.push({ label: "Ask something else on the Start flow tab", onClick: null, disabled: true });
  else chips.push({ label: "…working", onClick: null, disabled: true });

  return (
    <div className="atlas" data-testid="atlas-chat">
      <section className="atlas-phone" aria-label="Chat with your personal agent">
        <div className="atlas-phone__head"><span className="atlas-avatar" aria-hidden>A</span> Agent <span className="atlas-mode" data-testid="atlas-mode">{live ? `· Claude, live (${info.chatAgent.model})` : "· guided script"}</span></div>
        <div className="atlas-phone__chat">
          <p className="atlas-bubble atlas-bubble--agent" data-testid="atlas-greeting">{live ? GREETING_LIVE : GREETING_GUIDED}</p>
          {chat.map((c, i) => (
            <p key={i} className={`atlas-bubble atlas-bubble--${c.who}`}>{c.text}</p>
          ))}
          {busy && <p className="atlas-bubble atlas-bubble--agent muted" data-testid="atlas-typing">…thinking</p>}
          <div ref={chatEnd} />
        </div>
        {live && (
          <form className="atlas-input" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
            <label htmlFor="atlas-text" className="sr-only">Message your agent</label>
            <input id="atlas-text" data-testid="atlas-input" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} placeholder="Ask your agent…" autoComplete="off" disabled={busy} />
            {/* ui-pattern: allow P9 Send and the suggested-question chips stay secondary; the chat view's one red control is Simulate in the diagram's DiagramControls (dc-ctrl-btn--simulate), which the checker does not read as .primary */}
            <button type="submit" data-testid="atlas-send" disabled={busy || !draft.trim()}>Send</button>
          </form>
        )}
        {!live && info && !info.hosted && <p className="muted atlas-note" data-testid="atlas-guided-note">Guided script: set ANTHROPIC_API_KEY on the server to talk to a live Claude agent.</p>}
        {ready && !state?.discovery && (
          <fieldset className="atlas-company" data-testid="atlas-company" disabled={busy || phase === "discover"}>
            <legend>Which Company?</legend>
            <label htmlFor="atlas-origin">Company origin</label>
            <input id="atlas-origin" data-testid="atlas-origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://company.example" maxLength={300} autoComplete="off" spellCheck={false} />
            <label htmlFor="atlas-issuer">Authorization server issuer</label>
            <input id="atlas-issuer" data-testid="atlas-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://pf.example:9031" maxLength={300} autoComplete="off" spellCheck={false} />
          </fieldset>
        )}
        <div className="atlas-chips" role="group" aria-label="Things to try">
          {chips.length
            ? chips.map((c, i) => <button key={i} type="button" data-testid={`atlas-chip-${i}`} onClick={c.onClick} disabled={c.disabled}>{c.label}</button>)
            : <p className="muted" data-testid="atlas-hint">{info?.hosted ? "This hosted build cannot reach a Company. Run the standalone to chat with the agent." : "Type the Company origin and the authorization server issuer above; a question to ask appears here."}</p>}
        </div>
      </section>

      <div className="col-handle" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" onPointerDown={onHandleDown} />

      <section className="atlas-flow" aria-label="The protocol arrows the chat caused">
        {msg && <p className="panel" data-testid="atlas-msg">{msg}</p>}
        <ol className="atlas-steps">
          {steps.length
            ? steps.map((s, i) => <StepRow key={i} step={s} open={openStep === i} onOpen={() => setOpenStep(openStep === i ? null : i)} />)
            : <li className="muted">Nothing yet. Click a suggested question under the chat.</li>}
        </ol>
        {diagram && (
          <PatternDiagram
            pattern={diagram}
            resetSignal={resetSignal}
            activeEdge={activeArrow}
          />
        )}
      </section>
    </div>
  );
}
