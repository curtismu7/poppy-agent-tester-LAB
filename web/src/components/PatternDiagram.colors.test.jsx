import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import PatternDiagram from "./PatternDiagram";
import FLOW from "../../../server/diagrams/poppy-flow.json";

// The same shape the server's buildDiagram sends.
const PATTERN = {
  title: FLOW.title, intro: FLOW.lede,
  nodes: FLOW.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.group, x: n.x, y: n.y })),
  steps: FLOW.steps.map((s) => { const e = FLOW.edges[s.edges[0]]; return { from: e.source, to: e.target, label: s.title, short: s.short, phase: s.phase, reply: !!e.dashed, spec: s.spec, plain: s.plain, fields: s.fields, say: s.what, why: s.why ?? "" }; }),
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

describe("the pop-up explains the step", () => {
  const open = (i) => fireEvent.click(screen.getByTestId(`dk-label-e${i}`));

  it("is not shown until a step is chosen, then opens from a click on an arrow label", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    expect(screen.queryByTestId("pattern-popup")).toBeNull();
    open(2);
    const pop = screen.getByTestId("pattern-popup");
    expect(pop).toHaveAttribute("role", "dialog");
    expect(pop.textContent).toContain("Step 3 of 10");
    expect(pop.textContent).toContain(PATTERN.steps[2].label);
    expect(pop.textContent).toContain(PATTERN.steps[2].plain);
    PATTERN.steps[2].fields.forEach((f) => expect(pop.textContent).toContain(f));
    expect(pop.textContent).toContain(PATTERN.steps[2].spec);
    expect(pop.textContent).toMatch(/Request: Personal Agent \(this app\) to PingFederate/);
  });

  it("Previous and Next move the walkthrough, and the ends are disabled", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    open(0);
    expect(screen.getByTestId("pattern-popup-prev")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pattern-popup-next"));
    expect(screen.getByTestId("pattern-popup").textContent).toContain("Step 2 of 10");
    expect(screen.getByTestId("narr-step-1")).toHaveAttribute("aria-current", "step");
    open(9);
    expect(screen.getByTestId("pattern-popup-next")).toBeDisabled();
  });

  it("closes with the close button and with Escape, and comes back on the next click", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    open(4);
    fireEvent.click(screen.getByTestId("pattern-popup-close"));
    expect(screen.queryByTestId("pattern-popup")).toBeNull();
    open(5);
    expect(screen.getByTestId("pattern-popup").textContent).toContain("Step 6 of 10");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pattern-popup")).toBeNull();
  });

  it("follows the walkthrough, unless the pop-up toggle is off", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(screen.getByTestId("pattern-popup").textContent).toContain("Step 1 of 10");
    fireEvent.click(screen.getByTestId("pattern-popup-auto"));
    expect(screen.queryByTestId("pattern-popup")).toBeNull();
    fireEvent.click(screen.getByTestId("narr-step-3"));
    expect(screen.queryByTestId("pattern-popup")).toBeNull();
    open(3);
    expect(screen.getByTestId("pattern-popup").textContent).toContain("Step 4 of 10");
  });
});

describe("the diagram CSS follows the UI rules", () => {
  it("uses theme tokens only: no colour literals, and nothing purple", () => {
    const css = fs.readFileSync(new URL("./PatternDiagram.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || []).toEqual([]);
    expect(css).not.toMatch(/purple|violet|indigo/i);
  });
});
