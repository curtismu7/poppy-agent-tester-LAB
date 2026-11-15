import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import DiagramStepBar from "./DiagramStepBar";
import { markEdges, useDiagramStepper } from "../hooks/useDiagramStepper";
import { REFIT_EVENT, useFitOnResize } from "../hooks/useFitOnResize";
import "./PatternDiagram.css";

const FIT = { padding: 0.08 };
const HANDLES = [["t", Position.Top], ["b", Position.Bottom], ["l", Position.Left], ["r", Position.Right]];

function Box({ data }) {
  return (
    <div className={`pat-node pat-node--${data.kind}${data.on ? " pat-node--on" : ""}`}>
      {HANDLES.map(([k, pos]) => (
        <span key={k}>
          <Handle id={`s-${k}`} type="source" position={pos} className="pat-handle" />
          <Handle id={`t-${k}`} type="target" position={pos} className="pat-handle" />
        </span>
      ))}
      {data.label}
    </div>
  );
}
const nodeTypes = { box: Box };

// An edge that draws its own label. A request and its reply run along the same pair of sides, so each is shifted sideways by
// data.dy (up/down for left-right pairs, left/right for top-bottom pairs): two parallel arrows, two readable labels, nothing
// looping out of the canvas.
function LabelEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  // The ends move only a little (ENDPOINT_SHIFT) so the arrowheads stay on their boxes; the label takes the full offset.
  const horizontal = sourcePosition === Position.Left || sourcePosition === Position.Right;
  const along = Math.max(-ENDPOINT_SHIFT, Math.min(ENDPOINT_SHIFT, data.dy));
  const sx = sourceX + (horizontal ? 0 : along); const sy = sourceY + (horizontal ? along : 0);
  const tx = targetX + (horizontal ? 0 : along); const ty = targetY + (horizontal ? along : 0);
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div className={`pat-elabel${data.now ? " pat-elabel--now" : ""}${data.dim ? " pat-elabel--dim" : ""}`} data-testid="edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${lx + (horizontal ? 0 : data.dy - along)}px, ${ly + (horizontal ? data.dy - along : 0)}px)` }}>{data.text}</div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { label: LabelEdge };

// Every step on the same pair of boxes (either direction) gets its own slot, spread evenly around the centre line, so a pair that
// carries several requests and replies draws parallel arrows with separate labels (4 steps: -39, -13, +13, +39 px).
const SLOT = 26;
const ENDPOINT_SHIFT = 10; // px: how far an arrow end may move off its handle
export function labelOffsets(steps) {
  const key = (s) => [s.from, s.to].sort().join('|');
  const total = new Map(); const seen = new Map();
  for (const s of steps) total.set(key(s), (total.get(key(s)) || 0) + 1);
  return steps.map((s) => {
    const k = key(s); const j = seen.get(k) || 0; seen.set(k, j + 1);
    return (j - (total.get(k) - 1) / 2) * SLOT;
  });
}

// Pick the sides of the two boxes that face each other, so an arrow leaves toward its target.
function sides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ["r", "l"] : ["l", "r"]) : (dy > 0 ? ["b", "t"] : ["t", "b"]);
}

function Canvas({ pattern, positions, onMove, stepper, activeEdge = null }) {
  const ref = useRef(null);
  useFitOnResize(ref, FIT);
  const active = stepper && stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  const nodes = pattern.nodes.map((n) => ({
    id: n.id, type: "box", position: positions[n.id], draggable: true,
    data: { label: n.label, kind: n.kind, on: !!active && (active.from === n.id || active.to === n.id) },
  }));
  const offs = labelOffsets(pattern.steps);
  const pageDriven = activeEdge !== null && activeEdge >= 0;
  const edges = markEdges(pattern.steps.map((s, i) => {
    // Each arrow leaves the side facing its target; a reply uses the same pair of sides as its request, shifted by labelOffsets.
    const [a, b] = sides(positions[s.from], positions[s.to]);
    const cp = s.to === "rule";
    const now = stepper ? stepper.step === i : false;
    const seen = stepper && stepper.step >= 0 && i <= stepper.step;
    return {
      id: `e${i}`, source: s.from, target: s.to, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, type: "label",
      animated: now, data: { text: `${i + 1}. ${s.label}`, dy: offs[i], now, dim: stepper && stepper.step >= 0 && !seen },
      className: `pat-edge${cp ? " pat-edge--cp" : ""}${now ? " pat-edge--now" : ""}${stepper && stepper.step >= 0 && !seen ? " pat-edge--dim" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  }), pageDriven ? [activeEdge] : []);
  return (
    <div ref={ref} className="pat-canvas" data-testid="pattern-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={FIT} nodesConnectable={false} minZoom={0.3}
        onNodeDragStop={(_, n) => onMove(n.id, n.position)} onNodeDrag={(_, n) => onMove(n.id, n.position)} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// The explanation that travels with the walkthrough: beside the canvas, always the same size (no layout jump), so the arrow in focus
// and what it means are on screen together. Before Simulate it lists the steps; any step can be clicked to jump there.
function Narration({ steps, stepper }) {
  const i = stepper.step;
  const step = i >= 0 ? steps[i] : null;
  return (
    <aside className="pat-narr" aria-label="What each step means" data-testid="pattern-narration">
      {/* Live only while paused: during auto-play the step bar's short caption is the announcement, so a screen reader is not
          queued a full explanation every 2.5 s. Focusable, because on a narrow screen it scrolls. */}
      <div className="pat-narr__now" role="region" aria-label="Current step explanation" tabIndex={0} aria-live={stepper.paused ? "polite" : "off"} data-testid="pattern-now">
        {step ? (
          <>
            <p className="pat-narr__count">Step {i + 1} of {steps.length}</p>
            <h3>{step.label}</h3>
            <h4>What happens</h4>
            <p>{step.say}</p>
            {step.why && (<><h4>Why it matters</h4><p>{step.why}</p></>)}
          </>
        ) : (
          <>
            <h3>Press Simulate</h3>
            <p>The {steps.length} arrows play in order, and each one is explained here as it happens: what the request is, and why it is there. Pause any time, or pick a step below.</p>
          </>
        )}
      </div>
      <ol className="pat-narr__list">
        {steps.map((s, n) => (
          <li key={n}>
            <button type="button" className={`pat-narr__item${n === i ? " is-now" : n < i ? " is-done" : ""}`} aria-current={n === i ? "step" : undefined}
              onClick={() => stepper.goTo(n)} data-testid={`narr-step-${n}`}>
              <span className="pat-narr__n">{n + 1}</span> {s.label}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export default function PatternDiagram({ pattern, resetSignal = 0, activeEdge = null }) {
  const initial = useMemo(() => Object.fromEntries(pattern.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), [pattern]);
  const [positions, setPositions] = useState(initial);
  const stepper = useDiagramStepper(pattern.steps.length);
  const onMove = useCallback((id, p) => setPositions((cur) => ({ ...cur, [id]: { x: p.x, y: p.y } })), []);
  // A page that passes activeEdge at all (the chat, -1 before its first step) drives the highlight itself and gets no narration panel.
  const pageDriven = activeEdge !== null;
  const pageHasArrow = pageDriven && activeEdge >= 0;
  const step = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  // Reset restores box positions as well as the walkthrough and the view. The page-level Reset raises resetSignal.
  const reset = useCallback(() => { stepper.stop(); setPositions(initial); setTimeout(() => window.dispatchEvent(new Event(REFIT_EVENT)), 0); }, [stepper.stop, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef(resetSignal);
  useEffect(() => { if (seen.current !== resetSignal) { seen.current = resetSignal; reset(); } }, [resetSignal, reset]);
  return (
    <section className="pat" aria-label={pattern.title}>
      <h2 className="pat__title">{pattern.title}</h2>
      <p className="pat__lede">{pattern.intro}</p>
      <DiagramStepBar stepper={stepper} caption={step ? step.label : ""} testId="pattern-step-bar" />
      {pageHasArrow && activeEdge < pattern.steps.length && (
        <article className="track__now" data-testid="pattern-page-now">
          <h3>Arrow {activeEdge + 1}: {pattern.steps[activeEdge].label}</h3>
          <p>{pattern.steps[activeEdge].say}</p>
        </article>
      )}
      <button type="button" className="pat-reset" onClick={reset} data-testid="pattern-reset">Reset positions and walkthrough</button>
      <div className={pageDriven ? undefined : "pat-stage"}>
        <ReactFlowProvider>
          {/* The canvas follows the page only once it names an arrow; before that (the chat at -1) the step bar still walks it. */}
          <Canvas pattern={pattern} positions={positions} onMove={onMove} stepper={pageHasArrow ? null : stepper} activeEdge={pageHasArrow ? activeEdge : null} />
        </ReactFlowProvider>
        {!pageDriven && <Narration steps={pattern.steps} stepper={stepper} />}
      </div>
      <p className="keys">Drag any box. Moved: {Object.keys(positions).filter((k) => positions[k].x !== initial[k].x || positions[k].y !== initial[k].y).length} box(es).</p>
    </section>
  );
}
