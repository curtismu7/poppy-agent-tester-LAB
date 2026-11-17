import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PatternDiagram from "./PatternDiagram";
import FLOW from "../../../server/diagrams/poppy-flow.json";

// The same shape the server's buildDiagram sends.
const PATTERN = {
  title: FLOW.title, intro: FLOW.lede,
  nodes: FLOW.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.group, x: n.x, y: n.y })),
  steps: FLOW.steps.map((s) => { const e = FLOW.edges[s.edges[0]]; return { from: e.source, to: e.target, label: s.title, short: s.short, phase: s.phase, reply: !!e.dashed, say: s.what, why: s.why ?? "" }; }),
};

afterEach(cleanup);

describe("the diagram is coloured by phase and its canvas labels are short", () => {
  it("shows a legend with the four phases and the steps each covers", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    const legend = screen.getByTestId("pattern-legend");
    const items = [...legend.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/Discover.*steps 1-2/);
    expect(items[1]).toMatch(/signs in.*steps 3-6/);
    expect(items[2]).toMatch(/token.*steps 7-8/);
    expect(items[3]).toMatch(/Call the API.*steps 9-10/);
  });

  it("the step list numbers carry the phase class and the full step titles stay there", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    PATTERN.steps.forEach((s, i) => {
      const item = screen.getByTestId(`narr-step-${i}`);
      expect(item.className).toContain(`pat-narr__item--${s.phase}`);
      expect(item.textContent).toContain(s.label);
    });
  });

  it("a pattern without phases draws no legend and no per-label colour rules", () => {
    const plain = { ...PATTERN, steps: PATTERN.steps.map(({ phase, short, reply, ...s }) => s) };
    const { container } = render(<PatternDiagram pattern={plain} />);
    expect(screen.queryByTestId("pattern-legend")).toBeNull();
    expect(container.querySelector(".pat-canvas style")).toBeNull();
  });

  it("the canvas colours each label by its phase", () => {
    const { container } = render(<PatternDiagram pattern={PATTERN} />);
    const css = container.querySelector(".pat-canvas style").textContent;
    PATTERN.steps.forEach((s, i) => expect(css).toContain(`[data-label-id="e${i}"]{--ph:var(--ph-${s.phase})}`));
  });
});
