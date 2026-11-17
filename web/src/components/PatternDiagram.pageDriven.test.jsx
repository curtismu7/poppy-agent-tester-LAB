// The chat page hands PatternDiagram an activeEdge instead of running the walkthrough; the arrow it lights must be the one whose label the kit marks.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PatternDiagram from "./PatternDiagram";

afterEach(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 120)); }); cleanup(); vi.restoreAllMocks(); });

const pattern = {
  title: "Demo flow", intro: "An agent asks, a gate checks.",
  nodes: [{ id: "agent", label: "Agent", kind: "actor", x: 0, y: 0 }, { id: "gate", label: "Gate", kind: "gateway", x: 300, y: 0 }],
  steps: [{ from: "agent", to: "gate", label: "asks", say: "The agent asks." }, { from: "gate", to: "agent", label: "answers", say: "The gate answers." }],
};
const lit = () => [...document.querySelectorAll(".dk-label--on")].map((l) => l.textContent);

describe("a page-driven diagram (activeEdge)", () => {
  it("marks the label of the arrow the page reached, and only that one", () => {
    render(<PatternDiagram pattern={pattern} activeEdge={1} />);
    expect(lit()).toEqual(["2. answers"]);
  });
  it("marks nothing before the page's first step (activeEdge -1)", () => {
    render(<PatternDiagram pattern={pattern} activeEdge={-1} />);
    expect(lit()).toEqual([]);
  });
  it("hands the canvas to the walkthrough when Simulate is pressed", () => {
    render(<PatternDiagram pattern={pattern} activeEdge={1} />);
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(lit()).toEqual(["1. asks"]);
  });
});
