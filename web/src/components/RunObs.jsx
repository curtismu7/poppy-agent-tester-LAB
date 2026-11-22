// Rule 27: the shared "what each layer logged for this run" panel under the Start flow calls. Mock: the example run's own signings
// (simulated). Real: the replies the lab received plus the products' logs read from Elasticsearch, so it offers a Re-read button and
// reads once more shortly after each step (the collector ships with a delay). Mock needs neither.
import { useEffect, useRef, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { getRunObservability } from "../api";

export const REREAD_MS = 5000;
const TITLE = "What each layer logged for this run";

// Where this lab's own logs live and where they stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "Poppy Agent Tester server (this lab)", lives: "the lab container's stdout: one timestamped line per step (who decided, the outcome; never a token or an id)", streams: "the family log collector to demo-logs-poppy-agent-tester, then a SIEM, when the collector is set to watch this container (the lab does not ship them itself)" },
  { product: "PingFederate", lives: "container stdout (the image tails audit.log and server.log)", streams: "the collector to ping-logs-pingfederate, then a SIEM (audit.log is not shipped today)" },
  { product: "PingOne (sign-in)", lives: "the PingOne audit activity API (SaaS)", streams: "not shipped or read here yet" },
  { product: "The Company you typed", lives: "wherever that server writes its log; this lab does not know", streams: "not read by this lab" },
];

const Note = ({ testId, children }) => <p className="ro-muted" data-testid={testId}>{children}</p>;

export default function RunObs({ mode, tick, reset }) {
  // null = nothing asked yet; { mode, pending, record, message } = asked in `mode`; a record from the other mode is never shown.
  const [state, setState] = useState(null);
  const [again, setAgain] = useState(0);
  const seenTick = useRef(tick);
  useEffect(() => {
    if (mode !== "mock" && mode !== "real") return undefined;
    let live = true;
    const load = () => {
      setState((s) => (s && s.mode === mode ? { ...s, pending: true } : { mode, pending: true }));
      getRunObservability().then(
        (b) => { if (live) setState({ mode, record: b && "record" in b ? b.record : b, message: b?.message }); },
        () => { if (live) setState({ mode, record: { error: "unreachable", message: "Could not reach the server." } }); },
      );
    };
    load();
    // Only a step (a new tick) earns the late re-read, not a mode switch or a Re-read press.
    const stepped = tick !== seenTick.current;
    seenTick.current = tick;
    const later = mode === "real" && stepped ? setTimeout(load, REREAD_MS) : null;
    return () => { live = false; clearTimeout(later); };
  }, [mode, tick, again, reset]);

  if (mode !== "mock" && mode !== "real") return null;
  const mine = state && state.mode === mode ? state : null;
  const body = !mine || (mine.pending && !mine.record)
    ? <Note testId="ro-loading">Collecting this run's logs...</Note>
    : !mine.record && mine.message
      ? <><h2>{TITLE}</h2><Note testId="ro-none">{mine.message}</Note></>
      : <RunObservability record={mine.record} source={mode} streams={RUN_OBS_STREAMS} />;
  return (
    <div className="rp-obs" data-testid="rp-obs">
      {body}
      {mode === "real" && <p><button type="button" onClick={() => setAgain((n) => n + 1)} disabled={Boolean(mine?.pending)} data-testid="ro-reread">Re-read logs</button></p>}
      <p className="ro-muted" data-testid="ro-lanes-note">In this lab: Person is the issuer's sign-in reply, Agent is the personal agent (its own signing in Mock, the issuer's answer to its pushed request in Real; no on-behalf-of exchange happens here), and Resource server is the Company, a Poppy server rather than an MCP server. Authorize, Privilege and Agent gateway are not used.</p>
    </div>
  );
}
