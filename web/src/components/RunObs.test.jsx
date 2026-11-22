// Rule 27: the page side. The shared panel gets the page's current mode as `source`; Real offers Re-read logs and one late re-read per step; Mock neither.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RunObs, { REREAD_MS, RUN_OBS_STREAMS } from "./RunObs";
import App from "../App";
import { setJsonView } from "./JsonPane";
import { emptyRecord, errorRecord, mockRecord, realRecord } from "../run-observability/fixtures";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
let answer; // what GET /api/run-observability answers next
const reads = () => globalThis.fetch.mock.calls.filter(([u]) => u === "/api/run-observability").length;
beforeEach(() => {
  window.history.replaceState(null, "", "/"); setJsonView("raw");
  answer = () => json({ record: mockRecord });
  globalThis.fetch = vi.fn((url) => (url === "/api/run-observability" ? answer() : json({ error: "nope" }, 404)));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("RunObs", () => {
  it("Mock: shows the record as simulated under the page's mode, with no Re-read button, and a loading state first (not the empty state)", async () => {
    render(<RunObs mode="mock" tick={0} reset={0} />);
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("ro-empty")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("run-observability")).toBeInTheDocument());
    expect(screen.getByTestId("ro-basis").textContent).toMatch(/Simulated/);
    expect(screen.queryByTestId("ro-reread")).toBeNull();
    expect(screen.queryByTestId("ro-no-source")).toBeNull();
  });

  it("Real: shows a Re-read logs button that reads again", async () => {
    answer = () => json({ record: realRecord });
    render(<RunObs mode="real" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/Real:/));
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByTestId("ro-reread"));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("Real: each step reads at once and once more after about 5 s; Mock reads at once and never again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    answer = () => json({ record: realRecord });
    const { rerender } = render(<RunObs mode="real" tick={0} reset={0} />);
    await act(async () => { await Promise.resolve(); });
    const before = reads();
    rerender(<RunObs mode="real" tick={1} reset={0} />);
    await act(async () => { await Promise.resolve(); });
    expect(reads()).toBe(before + 1);
    await act(async () => { vi.advanceTimersByTime(REREAD_MS - 1); });
    expect(reads()).toBe(before + 1);
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(reads()).toBe(before + 2);
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(reads()).toBe(before + 2);
    cleanup();
    answer = () => json({ record: mockRecord });
    const m = render(<RunObs mode="mock" tick={0} reset={0} />);
    await act(async () => { await Promise.resolve(); });
    const base = reads();
    m.rerender(<RunObs mode="mock" tick={1} reset={0} />);
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(reads()).toBe(base + 1);
  });

  it("a mode switch is not a step: no late re-read, and the other mode's record is never shown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rerender } = render(<RunObs mode="mock" tick={3} reset={0} />);
    await act(async () => { await Promise.resolve(); });
    answer = () => new Promise(() => {}); // Real never answers
    rerender(<RunObs mode="real" tick={3} reset={0} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("run-observability")).toBeNull();
    const n = reads();
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(reads()).toBe(n);
  });

  it("switches both ways: Mock, Real, Mock each show their own record", async () => {
    const { rerender } = render(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/Simulated/));
    answer = () => json({ record: realRecord });
    rerender(<RunObs mode="real" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/Real:/));
    answer = () => json({ record: mockRecord });
    rerender(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/Simulated/));
    expect(screen.queryByTestId("ro-reread")).toBeNull();
  });

  it("a record from the other mode is refused on screen, not shown under the wrong label", async () => {
    answer = () => json({ record: realRecord });
    render(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-mismatch")).toBeInTheDocument());
  });

  it("no run yet: the route's message, not the empty state and not a loading spinner", async () => {
    answer = () => json({ record: null, message: "No run yet in this workspace: read a Company (step 1) to start one." });
    render(<RunObs mode="real" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-none").textContent).toMatch(/No run yet/));
    expect(screen.queryByTestId("ro-loading")).toBeNull();
    expect(screen.getByTestId("ro-reread")).toBeInTheDocument();
  });

  it("an error body ({error, message}) is shown as the panel's error, and a dead server is a named error too", async () => {
    answer = () => json(errorRecord, 500);
    render(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/endedAt is before startedAt/));
    cleanup();
    answer = () => Promise.reject(new Error("down"));
    render(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/Could not reach the server/));
  });

  it("an empty record shows the panel's honest empty rows, and the lanes note says what each lane holds here", async () => {
    answer = () => json({ record: emptyRecord });
    render(<RunObs mode="mock" tick={0} reset={0} />);
    await waitFor(() => expect(screen.getByTestId("run-observability")).toBeInTheDocument());
    const note = screen.getByTestId("ro-lanes-note").textContent;
    expect(note).toMatch(/Company, a Poppy server rather than an MCP server/);
    expect(note).toMatch(/no on-behalf-of exchange/);
  });

  it("says where this lab's logs live and where they stream", () => {
    expect(RUN_OBS_STREAMS.map((s) => s.product).join("|")).toMatch(/this lab.*PingFederate.*PingOne.*Company/);
    expect(RUN_OBS_STREAMS.every((s) => s.lives && s.streams)).toBe(true);
  });

  it("renders nothing until the page knows its mode", () => {
    const { container } = render(<RunObs mode={undefined} tick={0} reset={0} />);
    expect(container.textContent).toBe("");
    expect(reads()).toBe(0);
  });
});

describe("on the Start flow calls page", () => {
  const INFO = { hosted: true, configured: false, source: "mock", realAvailable: true, defaults: {}, registered: { available: false } };
  const open = async (info) => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/info") return json(info);
      if (url === "/api/state") return json({ workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] });
      if (url === "/api/sample") return json({ example: true, note: "EXAMPLE", steps: [] });
      if (url.startsWith("/api/story")) return json({ verticals: ["banking"], cast: {}, talkTrack: [] });
      if (url === "/api/run-observability") return answer();
      return json({ error: "nope" }, 404);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("pager-next")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pager-next"));
  };
  it("the panel sits under the calls in the page's current mode, and the first page does not ask for it", async () => {
    await open(INFO);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/Simulated/));
    expect(screen.getByTestId("rp-obs")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The calls" })).toBeInTheDocument();
  });
  it("Real: the panel is read-only next to the toggle, which is untouched", async () => {
    answer = () => json({ record: null, message: "No run yet in this workspace: read a Company (step 1) to start one." });
    await open({ ...INFO, hosted: false, configured: true, source: "real" });
    await waitFor(() => expect(screen.getByTestId("ro-none")).toBeInTheDocument());
    expect(screen.getByTestId("ro-reread")).toBeInTheDocument();
    expect(screen.getByTestId("mode-badge").textContent).toBe("Real");
  });
});
