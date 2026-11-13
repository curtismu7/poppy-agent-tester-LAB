// Atlas-style chat: a phone-style conversation on the left, the protocol arrows it caused on the right.
// The chips call the same real API as the Run it tab (discover, authorize, call); nothing is simulated here
// beyond the scripted chat lines themselves, which say what the real requests did.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../api";
import Json from "./Json";
import PatternDiagram from "./PatternDiagram";
import { markEdges } from "../hooks/useDiagramStepper";

const SPEC = "https://personalagentprotocol.org/docs/0.4/spec";

// The arrow each protocol step highlights on the diagram (indexes into the poppy-flow edges, in order).
// discover highlights arrow 0, sign-in arrows 2-3, call arrows 4-5.
const STEP_ARROW = { discover: 0, authorize: 2, token: 3, call: 4 };

// One scripted conversation line per real step kind. personLine is what the user "said"; agentLine is what
// the agent answers once the step completes. They reference real values from the run, never invented ones.
const SCRIPT = {
  discover: {
    person: "Do they have my size in stock?",
    agentLine: (state) => `Found them. I read ${host(state?.config?.origin)}'s documents: ${scopeNames(state).join(", ") || "no scopes published"}, sign-in at ${host(state?.config?.issuer) || "the issuer it names"}.`,
    need: "You asked about stock. Reading the Company's documents first.",
  },
  authorize: {
    person: "Where's my order?",
    agentLine: () => "To see your orders I need you signed in. PingFederate opens its own page; you sign in there and allow the read.",
    need: "That needs your sign-in. Opening PingFederate's page.",
  },
  token: {
    person: "(signed in at PingFederate)",
    agentLine: (state) => `Signed in. The token's client_id is my own metadata URL${state?.token?.claims?.sub ? `, and it names you as ${state.token.claims.sub}` : ""}.`,
  },
  call: {
    person: "So — where is it?",
    agentLine: (state, last) => lastCallLine(state, last),
  },
};

function host(u) { try { return new URL(u).host; } catch { return u || ""; } }
function scopeNames(state) { return Object.keys(state?.discovery?.poppy?.auth?.scopes ?? {}); }
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
    discover: "Read the Company's documents",
    authorize: "Sign in at PingFederate (client_id is a URL, PKCE)",
    token: "Exchange the code (private_key_jwt)",
    call: "Call the Company API with Bearer + Poppy-Session",
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
      {open && <Json value={detail} label={`${title} detail`} testId={`atlas-detail-${kind}`} />}
    </li>
  );
}

export default function AtlasChat({ info, resetSignal }) {
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

  useEffect(() => { getJson("/api/diagram?name=poppy-flow").then(setDiagram, () => setDiagram(null)); }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  const refresh = useCallback(() => getJson("/api/state").then((s) => {
    setState(s);
    if (s.config) { setOrigin((v) => v || s.config.origin); setIssuer((v) => v || s.config.issuer); }
    // A workspace with real progress resumes the conversation where it is; an untouched one stays idle.
    setPhase((p) => (p === "idle" && s.discovery ? (s.signedIn ? "signed-in" : "discovered") : p));
  }, () => setState(null)), []);
  useEffect(() => { refresh(); }, [refresh, resetSignal]);

  const say = (who, text) => setChat((c) => [...c, { who, text }]);
  const ready = info && !info.hosted;
  const scopes = scopeNames(state);
  const signedIn = Boolean(state?.signedIn);

  const steps = useMemo(() => (state?.steps ?? []).filter((s) => ["discover", "authorize", "token", "call"].includes(s.kind)), [state]);

  const highlight = (kind) => setActiveArrow(kind in STEP_ARROW ? STEP_ARROW[kind] : -1);

  const runDiscover = async () => {
    setMsg(""); setPhase("discover"); highlight("discover");
    say("person", SCRIPT.discover.person);
    const r = await postJson("/api/discover", { origin, issuer });
    await refresh();
    if (!r.ok) { setPhase("idle"); setMsg(r.body.message ?? r.body.error ?? `HTTP ${r.status}`); say("agent", "I could not read that Company. Check the origins on the Run it tab."); return; }
    setActiveArrow(0);
    say("agent", SCRIPT.discover.agentLine(state));
    setPhase("discovered");
  };

  const runSignIn = async () => {
    setMsg(""); setPhase("signin"); highlight("authorize");
    say("person", SCRIPT.authorize.person);
    say("agent", SCRIPT.authorize.need);
    const r = await postJson("/api/authorize", {});
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
    setActiveArrow(5);
    say("agent", SCRIPT.call.agentLine(state, r.body));
    setPhase("done");
  };

  // After the redirect back from PingFederate the workspace already holds the token.
  useEffect(() => {
    if (state?.signedIn && phase === "signin") {
      setActiveArrow(3);
      say("agent", SCRIPT.token.agentLine(state));
      setPhase("signed-in");
    }
  }, [state?.signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = [];
  if (phase === "idle") {
    if (origin && issuer) chips.push({ label: "Do they have my size in stock?", onClick: runDiscover });
    // else: the hint below explains where to type the origins
  }
  else if (phase === "discovered" && !signedIn) chips.push({ label: "Where's my order?", onClick: runSignIn, disabled: !info?.configured });
  else if (phase === "signed-in") chips.push({ label: "So — where is it?", onClick: runCall });
  else if (phase === "done") chips.push({ label: "Ask something else on the Run it tab", onClick: null, disabled: true });
  else chips.push({ label: "…working", onClick: null, disabled: true });

  return (
    <div className="atlas" data-testid="atlas-chat">
      <section className="atlas-phone" aria-label="Chat with your personal agent">
        <div className="atlas-phone__head"><span className="atlas-avatar" aria-hidden>A</span> Agent</div>
        <div className="atlas-phone__chat">
          {chat.map((c, i) => (
            <p key={i} className={`atlas-bubble atlas-bubble--${c.who}`}>{c.text}</p>
          ))}
          <div ref={chatEnd} />
        </div>
        <div className="atlas-chips" role="group" aria-label="Things to try">
          {chips.length
            ? chips.map((c, i) => <button key={i} type="button" data-testid={`atlas-chip-${i}`} onClick={c.onClick} disabled={c.disabled}>{c.label}</button>)
            : <p className="muted" data-testid="atlas-hint">Type the Company origin and the PingFederate issuer on the Run it tab first; the chat reuses them.</p>}
        </div>
      </section>

      <section className="atlas-flow" aria-label="The protocol arrows the chat caused">
        {msg && <p className="panel" data-testid="atlas-msg">{msg}</p>}
        <ol className="atlas-steps">
          {steps.length
            ? steps.map((s, i) => <StepRow key={i} step={s} open={openStep === i} onOpen={() => setOpenStep(openStep === i ? null : i)} />)
            : <li className="muted">Nothing yet. Pick a chip in the chat.</li>}
        </ol>
        {diagram && (
          <PatternDiagram
            pattern={{ ...diagram, steps: diagram.steps.map((s, i) => ({ ...s, say: i === activeArrow ? s.say : `${s.label} — run a step to light this arrow.` })) }}
            resetSignal={resetSignal}
            activeEdge={activeArrow}
          />
        )}
      </section>
    </div>
  );
}
