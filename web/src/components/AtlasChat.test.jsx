import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AtlasChat, { scopeSummary } from "./AtlasChat";
import { setJsonView } from "./JsonPane";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const STATE = { workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] };
const DIAGRAM = {
  title: "t", intro: "i",
  nodes: [
    { id: "agent", label: "Agent", kind: "actor", x: 0, y: 0 },
    { id: "pf", label: "PF", kind: "idp", x: 200, y: 0 },
    { id: "company", label: "Company", kind: "company", x: 400, y: 0 },
  ],
  steps: [
    { from: "agent", to: "company", label: "discover", say: "d" },
    { from: "agent", to: "pf", label: "authorize", say: "a" },
    { from: "agent", to: "company", label: "call", say: "c" },
  ],
};
const INFO = { hosted: false, configured: true, agentClientId: "https://agent.example/client.json", source: "real", realAvailable: true };

function mockApi({ state = STATE, post = {} } = {}) {
  globalThis.fetch = vi.fn((url, opts = {}) => {
    if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
    if (url === "/api/state") return json(state);
    if (opts.method === "POST" && post[url]) return typeof post[url] === "function" ? post[url]() : post[url];
    return json({ error: "nope" }, 404);
  });
}

beforeEach(() => { window.HTMLElement.prototype.scrollIntoView = vi.fn(); setJsonView("raw"); }); // the Form | JSON choice is shared module state
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AtlasChat", () => {
  it("starts the sign-in as the chat, so the browser comes back to this tab", async () => {
    const discovered = { ...STATE, config: { origin: "https://company.example", issuer: "https://pf.example", scope: "accounts:read" }, discovery: { ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } } };
    const sent = [];
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(discovered);
      if (url === "/api/authorize") { sent.push(JSON.parse(opts.body)); return json({ error: "stop here" }, 502); }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    const chip = await waitFor(() => screen.getByTestId("atlas-chip-0"));
    expect(chip.textContent).toMatch(/Where's my order/);
    fireEvent.click(chip);
    await waitFor(() => expect(sent).toEqual([{ from: "chat" }]));
  });

  it("shows the hint and no chips until the Company origins are known", async () => {
    mockApi();
    render(<AtlasChat info={INFO} resetSignal={0} />);
    await waitFor(() => expect(screen.getByText(/Type the Company origin/)).toBeInTheDocument());
    expect(screen.queryByTestId("atlas-chip-0")).toBeNull();
  });

  it("runs discover from a chip, adds the chat lines and a step row, and lights the arrow", async () => {
    const discoveredState = { ...STATE, config: { origin: "https://company.example", issuer: "https://pf.example", scope: "accounts:read" }, discovery: null, steps: [] };
    const post = {
      "/api/discover": json({ ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } }, resource: { resource: "https://company.example" } }),
    };
    // after the click, /api/state returns the discovered workspace
    let state = discoveredState;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(state);
      if (opts.method === "POST" && post[url]) { state = { ...discoveredState, discovery: { ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } }, steps: [{ kind: "discover", request: { urls: ["u"] }, response: { checks: [] } }] }; return post[url]; }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    const chip = await waitFor(() => screen.getByTestId("atlas-chip-0"));
    expect(chip.textContent).toMatch(/size in stock/);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("atlas-step-discover")).toBeInTheDocument());
    expect(screen.getAllByText(/Found them/).length).toBeGreaterThan(0);
    // the diagram highlights arrow 1 (discover) via the page-driven path
    expect(screen.getByTestId("pattern-page-now").textContent).toMatch(/Arrow 1/);
  });

  it("summarises a long scope list for the chat instead of listing every scope", () => {
    const scopes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}:read`, "x"]));
    const withWanted = { config: { scope: "s7:read" }, discovery: { poppy: { auth: { scopes } } } };
    expect(scopeSummary(withWanted)).toBe("50 scopes (s7:read and 49 more)");
    expect(scopeSummary({ config: { scope: "missing" }, discovery: { poppy: { auth: { scopes } } } })).toBe("50 scopes (s0:read, s1:read, s2:read and 47 more)");
    expect(scopeSummary({ discovery: { poppy: { auth: { scopes: { "accounts:read": "Read" } } } } })).toBe("1 scope (accounts:read)");
    expect(scopeSummary({ discovery: null })).toBe("no scopes published");
  });

  it("surfaces a discover failure as a chat line and a message, not a crash", async () => {
    mockApi({
      state: { ...STATE, config: { origin: "https://company.example", issuer: "https://pf.example" } },
      post: { "/api/discover": json({ error: "issuer_mismatch", message: "The Company publishes issuer https://real.example." }, 400) },
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    fireEvent.click(await screen.findByTestId("atlas-chip-0"));
    await waitFor(() => expect(screen.getByTestId("atlas-msg").textContent).toMatch(/real\.example/));
    expect(screen.getAllByText(/could not read that Company/i).length).toBeGreaterThan(0);
  });

  it("guided: with no defaults, the Company typed above the chat brings up the first chip and is what discover reads", async () => {
    const sent = [];
    let state = STATE;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(state);
      if (opts.method === "POST" && url === "/api/discover") {
        sent.push(JSON.parse(opts.body));
        state = { ...STATE, config: { origin: "https://company.example", issuer: "https://pf.example" }, discovery: { ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } }, steps: [{ kind: "discover", request: { urls: ["u"] }, response: { checks: [] } }] };
        return json({ ok: true, checks: [] });
      }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    await screen.findByText(/Type the Company origin and the PingFederate issuer above/);
    expect(screen.queryByTestId("atlas-chip-0")).toBeNull();
    fireEvent.change(screen.getByTestId("atlas-origin"), { target: { value: " https://company.example " } });
    expect(screen.queryByTestId("atlas-chip-0")).toBeNull(); // one box is not enough
    fireEvent.change(screen.getByTestId("atlas-issuer"), { target: { value: "https://pf.example" } });
    fireEvent.click(screen.getByTestId("atlas-chip-0"));
    await waitFor(() => expect(screen.getByTestId("atlas-step-discover")).toBeInTheDocument());
    expect(sent).toEqual([{ origin: "https://company.example", issuer: "https://pf.example" }]);
    // The agent line names what was just read, not the empty state from before the click.
    expect(screen.getByText(/company\.example's documents: 1 scope \(accounts:read\), sign-in at pf\.example/)).toBeInTheDocument();
    // Once read, the boxes go away and the next question is offered.
    expect(screen.queryByTestId("atlas-company")).toBeNull();
    expect(screen.getByTestId("atlas-chip-0").textContent).toMatch(/order/);
  });

  it("the hosted build shows no Company boxes and says why", async () => {
    mockApi();
    render(<AtlasChat info={{ ...INFO, hosted: true }} resetSignal={0} />);
    await screen.findByText(/hosted build cannot reach a Company/);
    expect(screen.queryByTestId("atlas-company")).toBeNull();
  });

  it("live mode: before the Company is read, the typed Company goes with the message", async () => {
    const sent = [];
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(STATE);
      if (url === "/api/chat" && opts.method !== "POST") return json({ messages: [] });
      if (url === "/api/chat") { sent.push(JSON.parse(opts.body)); return json({ reply: "ok", tools: [], signInUrl: null, messages: [] }); }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={{ ...INFO, chatAgent: { live: true, model: "m" } }} resetSignal={0} />);
    fireEvent.change(await screen.findByTestId("atlas-origin"), { target: { value: "https://company.example" } });
    fireEvent.change(screen.getByTestId("atlas-issuer"), { target: { value: "https://pf.example" } });
    fireEvent.change(screen.getByTestId("atlas-input"), { target: { value: "In stock?" } });
    fireEvent.click(screen.getByTestId("atlas-send"));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ text: "In stock?", origin: "https://company.example", issuer: "https://pf.example" });
  });

  it("greets, says it is the guided script, and uses the deployment's defaults so the first chip is there on a fresh load", async () => {
    mockApi();
    render(<AtlasChat info={{ ...INFO, defaults: { origin: "https://company.example", issuer: "https://pf.example" }, chatAgent: { live: false, reason: "no_key" } }} resetSignal={0} />);
    expect(screen.getByTestId("atlas-greeting").textContent).toMatch(/personal agent/);
    expect(screen.getByTestId("atlas-mode").textContent).toMatch(/guided script/);
    expect(screen.getByTestId("atlas-guided-note").textContent).toMatch(/ANTHROPIC_API_KEY/);
    expect(screen.queryByTestId("atlas-input")).toBeNull();
    const chip = await screen.findByTestId("atlas-chip-0");
    expect(chip.textContent).toMatch(/size in stock/);
  });

  it("live mode: the person types, the server agent answers, its tool lights the arrow", async () => {
    const LIVE = { ...INFO, chatAgent: { live: true, model: "claude-opus-5-5" } };
    let state = STATE;
    const sent = [];
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(state);
      if (url === "/api/chat" && opts.method !== "POST") return json({ messages: [] });
      if (url === "/api/chat") {
        sent.push(JSON.parse(opts.body));
        state = { ...STATE, discovery: { ok: true, checks: [] }, steps: [{ kind: "discover", request: { urls: ["u"] }, response: { checks: [] } }] };
        return json({ reply: "They publish accounts:read.", tools: [{ name: "read_company", status: 200 }], signInUrl: null, messages: [{ who: "person", text: sent[0].text }, { who: "agent", text: "They publish accounts:read." }] });
      }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={LIVE} resetSignal={0} />);
    expect(screen.getByTestId("atlas-mode").textContent).toMatch(/Claude, live \(claude-opus-5-5\)/);
    fireEvent.change(screen.getByTestId("atlas-input"), { target: { value: "Do they have my size?" } });
    fireEvent.click(screen.getByTestId("atlas-send"));
    await waitFor(() => expect(screen.getByText("They publish accounts:read.")).toBeInTheDocument());
    expect(sent).toEqual([{ text: "Do they have my size?" }]);
    expect(screen.getByTestId("atlas-step-discover")).toBeInTheDocument();
    expect(screen.getByTestId("pattern-page-now").textContent).toMatch(/Arrow 1/);
    // Once the Company is read, the suggestion moves on to the order question.
    expect((await screen.findByTestId("atlas-chip-0")).textContent).toMatch(/order/);
  });

  it("live mode: a server refusal puts the text back and shows the message", async () => {
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(STATE);
      if (url === "/api/chat" && opts.method !== "POST") return json({ messages: [] });
      if (url === "/api/chat") return json({ error: "model_error", message: "The model is rate limited (429)." }, 502);
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={{ ...INFO, chatAgent: { live: true, model: "m" } }} resetSignal={0} />);
    fireEvent.change(screen.getByTestId("atlas-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("atlas-send"));
    await waitFor(() => expect(screen.getByTestId("atlas-msg").textContent).toMatch(/429/));
    expect(screen.getByTestId("atlas-input").value).toBe("hello");
  });

  it("offers the call chip once signed in and shows the raw step detail on click", async () => {
    const token = "T".repeat(8);
    const callStep = { kind: "call", request: { method: "GET", url: "https://company.example/poppy/api/v1/me" }, response: { status: 200, body: { user_id: "person-1", session_id: "sid", scopes: ["accounts:read"] } } };
    let state = {
      ...STATE, signedIn: true,
      config: { origin: "https://company.example", issuer: "https://pf.example", scope: "accounts:read" },
      discovery: { ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } },
      token: { access_token: token, claims: { sub: "person-1" } },
      steps: [{ kind: "discover", request: { urls: ["u"] }, response: { checks: [] } }],
    };
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === "/api/diagram?name=poppy-flow") return json(DIAGRAM);
      if (url === "/api/state") return json(state);
      if (opts.method === "POST" && url === "/api/call") { state = { ...state, steps: [...state.steps, callStep] }; return json(callStep); }
      return json({ error: "nope" }, 404);
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    const chip = await screen.findByTestId("atlas-chip-0");
    expect(chip.textContent).toMatch(/where is it/);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("atlas-step-call")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("atlas-step-call").querySelector("button"));
    expect(screen.getByTestId("atlas-detail-call").textContent).toMatch(/"user_id": "person-1"/);
    expect(screen.getAllByText(/Here it is/).length).toBeGreaterThan(0);
  });
});
