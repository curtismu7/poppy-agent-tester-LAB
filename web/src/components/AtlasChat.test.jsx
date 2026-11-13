import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AtlasChat from "./AtlasChat";

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

beforeEach(() => { window.HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AtlasChat", () => {
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

  it("offers the call chip once signed in and shows the raw step detail on click", async () => {
    const token = "T".repeat(8);
    mockApi({
      state: {
        ...STATE, signedIn: true,
        config: { origin: "https://company.example", issuer: "https://pf.example", scope: "accounts:read" },
        discovery: { ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } },
        token: { access_token: token, claims: { sub: "person-1" } },
        steps: [{ kind: "discover", request: { urls: ["u"] }, response: { checks: [] } }],
      },
      post: {
        "/api/call": json({ kind: "call", request: { method: "GET", url: "https://company.example/poppy/api/v1/me" }, response: { status: 200, body: { user_id: "person-1", session_id: "sid", scopes: ["accounts:read"] } } }),
      },
    });
    render(<AtlasChat info={INFO} resetSignal={0} />);
    const chip = await screen.findByTestId("atlas-chip-0");
    expect(chip.textContent).toMatch(/where is it/);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("atlas-step-call")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("atlas-step-call").querySelector("button"));
    expect(screen.getByTestId("atlas-detail-call").textContent).toMatch(/person-1/);
    expect(screen.getAllByText(/Here it is/).length).toBeGreaterThan(0);
  });
});
