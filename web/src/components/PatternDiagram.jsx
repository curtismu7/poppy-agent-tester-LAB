import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import DiagramStepBar from "./DiagramStepBar";
import { useDiagramStepper } from "../hooks/useDiagramStepper";
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
  const horizontal = sourcePosition === Position.Left || sourcePosition === Position.Right;
  const sx = sourceX + (horizontal ? 0 : data.dy); const sy = sourceY + (horizontal ? data.dy : 0);
  const tx = targetX + (horizontal ? 0 : data.dy); const ty = targetY + (horizontal ? data.dy : 0);
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div className={`pat-elabel${data.now ? " pat-elabel--now" : ""}${data.dim ? " pat-elabel--dim" : ""}`} data-testid="edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>{data.text}</div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { label: LabelEdge };

// Every step on the same pair of boxes (either direction) gets its own slot, spread evenly around the centre line, so a pair that
// carries several requests and replies draws parallel arrows with separate labels (4 steps: -39, -13, +13, +39 px).
const SLOT = 26;
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

function Canvas({ pattern, positions, onMove, stepper }) {
  const ref = useRef(null);
  useFitOnResize(ref, FIT);
  const active = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  const nodes = pattern.nodes.map((n) => ({
    id: n.id, type: "box", position: positions[n.id], draggable: true,
    data: { label: n.label, kind: n.kind, on: !!active && (active.from === n.id || active.to === n.id) },
  }));
  const offs = labelOffsets(pattern.steps);
  const edges = pattern.steps.map((s, i) => {
    // Each arrow leaves the side facing its target; a reply uses the same pair of sides as its request, shifted by labelOffsets.
    const [a, b] = sides(positions[s.from], positions[s.to]);
    const cp = s.to === "rule";
    const now = stepper.step === i;
    const seen = stepper.step >= 0 && i <= stepper.step;
    return {
      id: `e${i}`, source: s.from, target: s.to, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, type: "label",
      animated: now, data: { text: `${i + 1}. ${s.label}`, dy: offs[i], now, dim: stepper.step >= 0 && !seen },
      className: `pat-edge${cp ? " pat-edge--cp" : ""}${now ? " pat-edge--now" : ""}${stepper.step >= 0 && !seen ? " pat-edge--dim" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
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

export default function PatternDiagram({ pattern, resetSignal = 0 }) {
  const initial = useMemo(() => Object.fromEntries(pattern.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), [pattern]);
  const [positions, setPositions] = useState(initial);
  const stepper = useDiagramStepper(pattern.steps.length);
  const onMove = useCallback((id, p) => setPositions((cur) => ({ ...cur, [id]: { x: p.x, y: p.y } })), []);
  const step = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  // Reset restores box positions as well as the walkthrough and the view. The page-level Reset raises resetSignal.
  const reset = useCallback(() => { stepper.stop(); setPositions(initial); setTimeout(() => window.dispatchEvent(new Event(REFIT_EVENT)), 0); }, [stepper.stop, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef(resetSignal);
  useEffect(() => { if (seen.current !== resetSignal) { seen.current = resetSignal; reset(); } }, [resetSignal, reset]);
  return (
    <section className="pat" aria-label={pattern.title}>
      <h2 className="pat__title">{pattern.title}</h2>
      <p className="intro">{pattern.intro}</p>
      <DiagramStepBar stepper={stepper} caption={step ? step.label : ""} testId="pattern-step-bar" />
      <button type="button" className="pat-reset" onClick={reset} data-testid="pattern-reset">Reset positions and walkthrough</button>
      {step && (
        <article className="track__now" data-testid="pattern-now">
          <h3>Step {stepper.step + 1}: {step.label}</h3>
          <p>{step.say}</p>
        </article>
      )}
      <ReactFlowProvider>
        <Canvas pattern={pattern} positions={positions} onMove={onMove} stepper={stepper} />
      </ReactFlowProvider>
      <p className="keys">Drag any box. Moved: {Object.keys(positions).filter((k) => positions[k].x !== initial[k].x || positions[k].y !== initial[k].y).length} box(es).</p>
    </section>
  );
}
