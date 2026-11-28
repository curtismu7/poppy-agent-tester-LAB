// The Agent tab: the simple view. One screen, the three moves Poppy makes as a step timeline,
// auto-run or step-by-step. The wire detail lives on the Details tab.
const STEPS = [
  { id: "discover", label: "Read the Company", what: "The agent reads two public documents: poppy.json (scopes and APIs) and the protected-resource document (the authorization server). No registration, no secret." },
  { id: "signin", label: "Sign in as the agent", what: "The client_id is the agent's metadata URL. PingFederate fetches it; the person signs in and allows the scope." },
  { id: "call", label: "Call with token and Poppy-Session", what: "Each request carries the access token and a signed Poppy-Session naming this method, this URL and this token." },
];

export default function AgentTab({ ui, c }) {
  const { state, busy, off, origin, setOrigin, issuer, setIssuer, stepMode, setStepMode, oneClick, discover, signIn, call } = c;
  const done = { discover: Boolean(state?.discovery), signin: Boolean(state?.signedIn), call: false };
  const active = !done.discover ? "discover" : !done.signin ? "signin" : "call";
  const step = (id) => (done[id] ? "done" : active === id ? "active" : "todo");
  return (
    <section className="rp-page" aria-labelledby="agent-h">
      <h2 id="agent-h" className="rp-title">Poppy, your personal agent</h2>
      <p className="muted">An agent arrives at a Company with no client registration and no shared secret: it names itself with a URL, the person signs in, and every call carries a signed session.</p>
      {ui}
      <div className="rp-controls">
        <p className="rp-controls__main">
          {/* ui-pattern: allow P9 Start flow is the one primary of the agent view: the three moves collapse into it (or the step buttons in Step mode) */}
          <button type="button" className="primary" onClick={oneClick} disabled={off || busy !== "" || stepMode} data-testid="one-click">Start flow</button>{" "}
          <label className="inline" htmlFor="step-mode"><input id="step-mode" type="checkbox" checked={stepMode} onChange={(e) => setStepMode(e.target.checked)} disabled={off || busy !== ""} />Take it step by step</label>
        </p>
        <div className="rp-fields">
          <div><label htmlFor="origin">Company origin</label>
            <input id="origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://company.example" spellCheck={false} autoComplete="off" /></div>
          <div><label htmlFor="issuer">Authorization server issuer</label>
            <input id="issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.example:9031" spellCheck={false} autoComplete="off" /></div>
        </div>
        {stepMode && (
          <p className="rp-steps">
            <button type="button" onClick={discover} disabled={off || busy !== "" || !origin || !issuer} data-testid="discover">{busy === "discover" ? "Reading..." : "1. Read the Company origin"}</button>
            <button type="button" onClick={signIn} disabled={off || busy !== "" || !state?.discovery} data-testid="signin">2. Sign in as the agent</button>
            <button type="button" onClick={() => call()} disabled={off || busy !== "" || !state?.signedIn} data-testid="call">3. Call with token and Poppy-Session</button>
          </p>
        )}
      </div>
      <ol className="agent-steps" data-testid="agent-steps">
        {STEPS.map((s) => (
          <li key={s.id} className={`agent-step agent-step--${step(s.id)}`} data-testid={`agent-step-${s.id}`} aria-current={step(s.id) === "active" ? "step" : undefined}>
            <span className="agent-step__mark" aria-hidden="true">{step(s.id) === "done" ? "✓" : STEPS.findIndex((x) => x.id === s.id) + 1}</span>
            <div>
              <h3>{s.label}{busy === s.id ? "…" : ""}</h3>
              <p>{s.what}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="muted" data-testid="intro-clients"><b>Who is the client?</b> With PingFederate the agent is its own client: the client_id is the URL of its client.json (CIMD). PingOne has no CIMD, so there the agent signs in with a registered client_id, set with PAT_P1_CLIENT_ID and PAT_DEMO_P1_ISSUER. Everything else is the same: PKCE, a signed assertion instead of a secret, and the Poppy-Session.</p>
    </section>
  );
}
