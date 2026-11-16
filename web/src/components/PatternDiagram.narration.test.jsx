import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PatternDiagram from "./PatternDiagram";
import { STEP_ARROW, ARROW_VERIFIED, TOOL_ARROW } from "./AtlasChat";
import FLOW from "../../../server/diagrams/poppy-flow.json";

// The same shape the server's buildDiagram sends.
const PATTERN = {
  title: FLOW.title, intro: FLOW.lede,
  nodes: FLOW.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.group, x: n.x, y: n.y })),
  steps: FLOW.steps.map((s) => { const e = FLOW.edges[s.edges[0]]; return { from: e.source, to: e.target, label: s.title, say: s.what, why: s.why ?? "" }; }),
};

afterEach(cleanup);

describe("the walkthrough explains itself", () => {
  it("before Simulate: says what will happen and lists every step", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    const now = screen.getByTestId("pattern-now");
    expect(now.textContent).toMatch(/Press Simulate/);
    expect(now.textContent).toMatch(new RegExp(`The ${PATTERN.steps.length} arrows play in order`));
    PATTERN.steps.forEach((s, i) => expect(screen.getByTestId(`narr-step-${i}`).textContent).toContain(s.label));
  });

  it("while it plays: the step in focus shows what happens and why it matters, and moves on by itself", () => {
    vi.useFakeTimers();
    try {
      render(<PatternDiagram pattern={PATTERN} />);
      fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
      const now = () => screen.getByTestId("pattern-now").textContent;
      expect(now()).toContain(`Step 1 of ${PATTERN.steps.length}`);
      expect(now()).toContain(PATTERN.steps[0].say);
      expect(now()).toContain(PATTERN.steps[0].why);
      expect(screen.getByTestId("narr-step-0")).toHaveAttribute("aria-current", "step");
      act(() => { vi.advanceTimersByTime(3000); });
      expect(now()).toContain(`Step 2 of ${PATTERN.steps.length}`);
      expect(now()).toContain(PATTERN.steps[1].why);
      expect(screen.getByTestId("narr-step-0").className).toMatch(/is-done/);
    } finally { vi.useRealTimers(); }
  });

  it("a step in the list jumps there and holds, so a presenter can talk over it", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    fireEvent.click(screen.getByTestId("narr-step-4"));
    expect(screen.getByTestId("pattern-now").textContent).toContain(PATTERN.steps[4].label);
    expect(screen.getByTestId("narr-step-4")).toHaveAttribute("aria-current", "step");
  });

  it("the explanation is the same element before and during the walk (no layout jump), quiet while auto-playing and announced once paused", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    const before = screen.getByTestId("pattern-now");
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(screen.getByTestId("pattern-now")).toBe(before);
    expect(before).toHaveAttribute("aria-live", "off"); // the step bar's short caption is the announcement while it plays
    fireEvent.click(screen.getByTestId("narr-step-3")); // a jump pauses
    expect(before).toHaveAttribute("aria-live", "polite");
    expect(before).toHaveAttribute("tabindex", "0"); // it scrolls on a narrow screen, so it takes focus
  });

  it("the lede is not the header's on-dark .intro text", () => {
    render(<PatternDiagram pattern={PATTERN} />);
    const lede = screen.getByText(PATTERN.intro);
    expect(lede.className).toBe("pat__lede");
  });

  it("a page-driven diagram (the chat) shows the page's arrow, the narration too, and Simulate takes the canvas until stopped", () => {
    render(<PatternDiagram pattern={PATTERN} activeEdge={2} />);
    expect(screen.getByTestId("pattern-narration")).toBeInTheDocument();
    expect(screen.getByTestId("pattern-page-now").textContent).toContain(PATTERN.steps[2].label);
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(screen.queryByTestId("pattern-page-now")).toBeNull(); // the walkthrough owns the canvas now
    expect(screen.getByTestId("pattern-now").textContent).toContain(PATTERN.steps[0].why);
    fireEvent.click(screen.getByTestId("pattern-reset"));
    expect(screen.getByTestId("pattern-page-now").textContent).toContain(PATTERN.steps[2].label); // back to the page's arrow
  });
  it("the chat before its first step (activeEdge -1): narration, no empty box, and Simulate walks the arrows", () => {
    render(<PatternDiagram pattern={PATTERN} activeEdge={-1} />);
    expect(screen.getByTestId("pattern-narration")).toBeInTheDocument();
    expect(screen.queryByTestId("pattern-page-now")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(screen.getByTestId("pattern-step-bar").textContent).toMatch(/Step 1 of/);
  });
});

describe("the flow data", () => {
  it("every step names one edge, says what happens and why", () => {
    expect(FLOW.steps).toHaveLength(FLOW.edges.length);
    FLOW.steps.forEach((s, i) => {
      expect(s.edges).toEqual([i]);
      expect(s.what.length).toBeGreaterThan(40);
      expect(s.why.length).toBeGreaterThan(40);
    });
  });
  it("teaches the 1.0 flow: PAR, the person's sign-in, the iss check, Poppy-Session and Poppy-Version", () => {
    const text = FLOW.steps.map((s) => `${s.title} ${s.what} ${s.why}`).join(" ");
    expect(text).not.toMatch(/no client is registered by hand/); // PingFederate needs an operator-made CIMD policy per agent URL
    for (const term of [/PAR/, /request_uri/, /private_key_jwt/, /RFC 9207/, /PKCE/, /Poppy-Session/, /Poppy-Version: 1\.0/, /poppy_dlg/, /version_unsupported/]) expect(text).toMatch(term);
  });
  it("the chat's arrow indexes still point at the steps they mean", () => {
    const title = (i) => FLOW.steps[i].title;
    expect(title(STEP_ARROW.discover)).toBe("Discover the Company");
    expect(title(2)).toMatch(/PAR/);
    expect(title(STEP_ARROW.authorize)).toBe("The person signs in");
    expect(title(STEP_ARROW.token)).toBe("The access token");
    expect(title(STEP_ARROW.call)).toBe("Call the API");
    expect(title(ARROW_VERIFIED)).toBe("The Company verifies");
    // the live agent's tools (agent chat) light the same arrows
    expect(title(TOOL_ARROW.read_company)).toBe("Discover the Company");
    expect(title(TOOL_ARROW.start_sign_in)).toBe("The person signs in");
    expect(title(TOOL_ARROW.call_company_api)).toBe("The Company verifies");
  });
});
