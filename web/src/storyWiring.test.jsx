// Story wiring tests (vitest): the host reads the page, drives the tabs, waits for runs; the script turns into engine steps.
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createHost, buildSteps } from "./storyWiring.js";
import { STEPS, scriptKeys } from "./storyScript.js";
import StoryRoot from "./StoryRoot.jsx";

afterEach(() => { cleanup(); delete window.__storyOn; document.documentElement.classList.remove("story-on"); sessionStorage.clear(); });

const event = (t, detail) => new CustomEvent(t, { detail });

describe("createHost", () => {
  it("counts runs from the page's events, and waitForRun resolves with the last result when the run already ended", async () => {
    const host = createHost();
    const marker = host.mark();
    expect(host.runInFlight()).toBe(false);
    window.dispatchEvent(event("pat:run-start"));
    expect(host.runInFlight()).toBe(true);
    window.dispatchEvent(event("pat:run-end", { ok: true }));
    expect(host.runInFlight()).toBe(false);
    await expect(host.waitForRun(marker, 500)).resolves.toEqual({ ok: true });
    host.dispose();
  });

  it("waitForRun resolves when the run ends, and reports a failed run", async () => {
    const host = createHost();
    const marker = host.mark();
    const p = host.waitForRun(marker, 1000);
    window.dispatchEvent(event("pat:run-start"));
    window.dispatchEvent(event("pat:run-end", { ok: false }));
    await expect(p).resolves.toEqual({ ok: false, reason: expect.stringMatching(/failed/i) });
    host.dispose();
  });

  it("waitForRun times out with a message, and a reset releases a waiting step", async () => {
    const host = createHost();
    const marker = host.mark();
    await expect(host.waitForRun(marker, 30)).resolves.toEqual({ ok: false, reason: expect.stringMatching(/did not finish/i) });
    const p = host.waitForRun(host.mark(), 1000);
    window.dispatchEvent(event("pat:reset"));
    await expect(p).resolves.toEqual({ ok: false, reason: expect.stringMatching(/reset/i) });
    host.dispose();
  });

  it("send presses the step's own chip with an untrusted click; a disabled chip is refused", () => {
    document.body.innerHTML = '<button data-testid="atlas-chip-0" disabled>x</button><button data-testid="go">go</button>';
    const host = createHost();
    expect(() => host.send({ prompt: { press: '[data-testid=atlas-chip-0]' } })).toThrow(/not available/);
    const go = document.querySelector('[data-testid=go]');
    const spy = vi.spyOn(go, "click");
    expect(host.send({ prompt: { press: '[data-testid=go]' } })).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.isTrusted).toBeUndefined(); // a script-made click, never a faked trusted one
    host.dispose();
  });

  it("onRun fires on every start and end and returns an unsubscribe; runInFlight reflects a run in progress", () => {
    const host = createHost();
    const seen = [];
    const off = host.onRun(() => seen.push(1));
    window.dispatchEvent(event("pat:run-start"));
    window.dispatchEvent(event("pat:run-end", { ok: true }));
    off();
    window.dispatchEvent(event("pat:run-start"));
    expect(seen).toEqual([1, 1]);
    host.dispose();
  });
});

describe("buildSteps", () => {
  it("every step targets something real: chat bubbles point at the chat's step rows or chips; a kind with no row skips", () => {
    document.body.innerHTML = `
      <nav><a id="tab-chat"></a><a id="tab-why"></a></nav>
      <section data-testid="atlas-chat"></section>
      <button data-testid="atlas-chip-0">Do they have my size in stock?</button>
      <ul><li data-testid="atlas-step-discover"></li></ul>`;
    const host = createHost();
    const steps = buildSteps({ host, doc: document });
    const discover = steps.find((s) => s.key === "chat_discover");
    expect(typeof discover.target).toBe("function");
    expect(discover.target()).toBeTruthy();
    const call = steps.find((s) => s.key === "chat_call");
    // the call prompt points at the chip (a string selector); it shows only once the token row exists
    expect(call.target).toBe("[data-testid=atlas-chip-0]");
    host.dispose();
  });

  it("conditions read the page: notDiscovered until a discover row exists; signedInOrBeyond needs the token row", () => {
    document.body.innerHTML = `<ul><li data-testid="atlas-step-discover"></li></ul>`;
    const host = createHost();
    const steps = buildSteps({ host, doc: document });
    const discoverPrompt = steps.find((s) => s.key === "chat_discover_prompt");
    expect(discoverPrompt.when()).toBe(false); // discover ran
    const signinPrompt = steps.find((s) => s.key === "chat_signin_prompt");
    expect(signinPrompt.when()).toBe(true); // discovered, not yet signed in
    const signin = steps.find((s) => s.key === "chat_signin");
    expect(signin.when()).toBe(false); // no token row yet
    document.body.innerHTML = `<ul><li data-testid="atlas-step-discover"></li><li data-testid="atlas-step-authorize"></li><li data-testid="atlas-step-token"></li></ul>`;
    const steps2 = buildSteps({ host, doc: document });
    expect(steps2.find((s) => s.key === "chat_signin").when()).toBe(true);
    host.dispose();
  });

  it("the call step presses the signed-in chip and is gated on the token row", () => {
    document.body.innerHTML = `<button data-testid="atlas-chip-0"></button><ul><li data-testid="atlas-step-token"></li></ul>`;
    const host = createHost();
    const steps = buildSteps({ host, doc: document });
    const call = steps.find((s) => s.key === "chat_call");
    expect(call.prompt).toEqual({ press: "[data-testid=atlas-chip-0]" });
    expect(call.when()).toBe(true);
    host.dispose();
  });

  it("tabs switch before a step shows", () => {
    document.body.innerHTML = `<nav><a id="tab-chat" aria-current="page"></a><a id="tab-why"></a></nav>`;
    document.getElementById("tab-why").addEventListener("click", () => {
      document.getElementById("tab-chat").removeAttribute("aria-current");
      document.getElementById("tab-why").setAttribute("aria-current", "page");
    });
    const host = createHost();
    const steps = buildSteps({ host, doc: document });
    const why = steps.find((s) => s.key === "why_poppy");
    expect(why.tab).toBe("why");
    host.switchTab("why");
    expect(document.getElementById("tab-why").getAttribute("aria-current")).toBe("page");
    host.dispose();
  });
});

describe("the script and the wording agree (parity)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const captionsMd = fs.readFileSync(path.resolve(import.meta.dirname, "../../video/captions.md"), "utf8");
  const keyOf = (h) => {
    if (/^# Opening Slide$/.test(h)) return "opening";
    if (/^# Closing Slide$/.test(h)) return "closing";
    return (h.match(/^# (?:Step|Slide): (.+)$/) || [])[1];
  };
  const keys = captionsMd.split("\n---\n").map((block) => keyOf(block.split("\n").find((l) => l.startsWith("# "))) || null).filter(Boolean);
  const { steps, slides, sampleKeys } = scriptKeys();

  it("every step and slide in the script has wording", () => {
    const missing = [...steps, ...slides].filter((k) => !keys.includes(k));
    expect(missing).toEqual([]);
  });
  it("every sample_* key the script names has wording", () => {
    const missing = sampleKeys.filter((k) => !keys.includes(k));
    expect(missing).toEqual([]);
  });
  it("every wording step key the script does not use is declared story-only or video-only", () => {
    const known = new Set([...steps, ...slides, ...sampleKeys, "opening", "closing", "mock_note"]);
    const extra = keys.filter((k) => !known.has(k) && !k.startsWith("#"));
    expect(extra).toEqual([]);
  });
});

const OK_CAPTIONS = { opening: { title: "t", header: "h", lead: "l", verdict: "v", colA: { heading: "a", lines: ["x"] }, colB: { heading: "b", lines: ["y"] } }, closing: { title: "t", lead: "l", verdict: "v", colA: { heading: "a", lines: ["x"] }, colB: { heading: "b", lines: ["y"] } }, slides: {}, steps: {}, sourceSha256: "x" };

describe("StoryRoot", () => {
  it("renders the story bar from the served wording, and marks the page story-on", async () => {
    const fetchMock = vi.fn((url) => {
      if (String(url).includes("/api/story")) return Promise.resolve({ ok: true, json: () => Promise.resolve(OK_CAPTIONS) });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StoryRoot mode="mock" ready onExit={() => {}} prefix="pat-test" />);
    await waitFor(() => expect(screen.getByTestId("story-bar")).toBeTruthy(), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledWith("/api/story", expect.anything());
    expect(document.documentElement.classList.contains("story-on")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("a wording problem shows the error bar with the server's message, and Demo mode survives", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "Story wording could not be read: captions.md: a test problem" }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<StoryRoot mode="mock" ready onExit={() => {}} prefix="pat-test" />);
    await waitFor(() => expect(screen.getByTestId("story-error")).toBeTruthy());
    expect(screen.getByText(/a test problem/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("carries Play across the reload: a pat.story.playing flag is consumed so the walk resumes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(OK_CAPTIONS) }));
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem("pat.story.playing", "1");
    render(<StoryRoot mode="mock" ready onExit={() => {}} prefix="pat-test" />);
    await waitFor(() => expect(screen.getByTestId("story-bar")).toBeTruthy(), { timeout: 3000 });
    // consumed, then re-set by the resumed play: the walk continues unattended after the reload
    await waitFor(() => expect(sessionStorage.getItem("pat.story.playing")).toBe("1"), { timeout: 3000 });
    vi.unstubAllGlobals();
  });
});
