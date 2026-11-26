// SequenceView — the chat's run as a lifeline sequence diagram with a movie-reel of wire-detail cards
// (the HITL-demo presentation). The steps are the SAME real steps the chat and the Run it tab produce
// (/api/state), mapped to sequence messages by web/src/liveSequence.js; nothing is invented, and a step
// that has not run draws as a ghost. The diagram component is vendored byte-for-byte from
// ciba-approval-sequence-LAB (pinned by scripts/sequence.sha256, checked by scripts/sequence-checkPin.mjs).
import { useMemo, useState } from "react";
import SequenceFlowDiagram from "./SequenceFlowDiagram.jsx";
import { buildSequence, sequenceDetails, sequenceSource, KIND_MESSAGE_INDEX } from "../liveSequence.js";

export default function SequenceView({ state, resetSignal, highlightKind = null }) {
  const steps = state?.steps ?? [];
  // One sequence per run: a new discover starts it over (the Calls page's "latest run" rule).
  const source = useMemo(() => sequenceSource(steps), [steps]);
  const stepDetails = useMemo(() => sequenceDetails(steps), [steps]);
  // The message the chat just drove: the FIRST sequence message of that kind (the request arrow).
  const lit = highlightKind != null && highlightKind in KIND_MESSAGE_INDEX ? KIND_MESSAGE_INDEX[highlightKind] : null;
  // Nothing run yet: an external `active` (empty) draws every message idle — honest ghosts — and the reel
  // does not render without a driver, so the intro line stands in. Once anything ran, a driver { step, goTo }
  // gives the highlight AND the movie reel; the lit message is the one the chat drove (or the last that ran).
  const lastRan = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) { const k = steps[i].kind; if (k in KIND_MESSAGE_INDEX) return KIND_MESSAGE_INDEX[k] + (k === steps[i].kind && steps[i].response ? 1 : 0); }
    return -1;
  }, [steps]);
  const driver = useMemo(() => {
    const step = lit ?? (lastRan >= 0 ? lastRan : -1);
    return { step, goTo: (n) => { setStepOverride(n); } };
  }, [lit, lastRan]);
  const [stepOverride, setStepOverride] = useState(null); // a card or message click jumps here (the driver's goTo)
  const shown = stepOverride ?? driver.step;
  if (!steps.length) {
    return (
      <section aria-label="The run as a sequence diagram" data-testid="sequence-view">
        <SequenceFlowDiagram source={source} label="The agent's sign-in and call, as a sequence" variant="lucid" active={[]} key={`ghost-${resetSignal}`} />
      </section>
    );
  }
  return (
    <section aria-label="The run as a sequence diagram" data-testid="sequence-view">
      <SequenceFlowDiagram
        source={source}
        label="The agent's sign-in and call, as a sequence"
        variant="lucid"
        stepDetails={stepDetails}
        driver={{ step: shown, goTo: (n) => setStepOverride(n) }}
        key={`${resetSignal}-${source.length}`}
      />
    </section>
  );
}
