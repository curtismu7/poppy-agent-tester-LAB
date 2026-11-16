import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App, { BANNER_FAILED, BANNER_UNKNOWN } from "./App";
import { setJsonView } from "./components/JsonPane";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const STATE = { workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] };
const DISCOVERED = { ...STATE, config: { origin: "https://company.example", issuer: "https://pf.example", scope: "accounts:read" }, discovery: { ok: true, checks: [{ id: "resource", ok: true, note: "resource matches" }], poppy: { auth: { scopes: { "accounts:read": "Read" } } } } };

function mockApi({ info = { hosted: false, configured: true, agentClientId: "https://agent.example/client.json", source: "real", realAvailable: true }, state = STATE, post = {} } = {}) {
  globalThis.fetch = vi.fn((url, opts = {}) => {
    if (url === "/api/info") return info === "fail" ? Promise.reject(new Error("down")) : json(info);
    if (url === "/api/state") return json(state);
    if (url.startsWith("/api/story")) return json({ verticals: ["banking", "retail"], cast: {}, talkTrack: [{ id: "say-first", title: "Say this first", say: "s" }, { id: "discover", title: "Discover", say: "d" }, { id: "signin", title: "Sign in", say: "i" }, { id: "call", title: "Call", say: "c" }, { id: "why", title: "Why two headers", say: "w" }] });
    if (url === "/api/sample") return json({ note: "EXAMPLE run: invented", steps: [{ kind: "call" }] });
    if (url.startsWith("/api/diagram")) return json({ title: "t", intro: "i", nodes: [{ id: "a", label: "A", kind: "actor", x: 0, y: 0 }, { id: "b", label: "B", kind: "idp", x: 200, y: 0 }], steps: [{ from: "a", to: "b", label: "go", say: "x" }] });
    if (opts.method === "POST" && post[url]) return post[url];
    if (url === "/api/reset") return json({ ok: true });
    return json({ error: "nope" }, 404);
  });
}

const toCalls = () => fireEvent.click(screen.getByTestId("pager-next"));
const toToken = () => { toCalls(); fireEvent.click(screen.getByTestId("pager-next")); };

beforeEach(() => { window.location.hash = ""; setJsonView("raw"); }); // the Form | JSON choice is shared module state: tests that read pane text say which view they read
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("banner", () => {
  it("says both until it knows, then LIVE locally", async () => {
    mockApi();
    render(<App />);
    expect(screen.getByTestId("banner").textContent).toBe(BANNER_UNKNOWN);
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toMatch(/^LIVE:/));
  });
  it("says HOSTED SIMULATION on the hosted build and keeps every action off", async () => {
    mockApi({ info: { hosted: true, configured: false } });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toMatch(/^HOSTED SIMULATION/));
    expect(screen.getByTestId("discover")).toBeDisabled();
    expect(screen.getByTestId("signin")).toBeDisabled();
    expect(screen.getByTestId("call")).toBeDisabled();
  });
  it("says MODE UNKNOWN (not 'loading') when /api/info fails, and offers no action", async () => {
    mockApi({ info: "fail" });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe(BANNER_FAILED));
    expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(true); // offers no action while the server is unreachable
    fireEvent.change(screen.getByLabelText("Company origin"), { target: { value: "https://company.example" } });
    fireEvent.change(screen.getByLabelText(/Authorization server issuer/), { target: { value: "https://pf.example" } });
    expect(screen.getByTestId("discover")).toBeDisabled();
    expect(screen.getByTestId("signin")).toBeDisabled();
    expect(screen.getByTestId("call")).toBeDisabled();
  });
  it("offers no action while the mode is still loading", () => {
    mockApi();
    render(<App />);
    toCalls();
    expect(screen.getByTestId("banner").textContent).toBe(BANNER_UNKNOWN);
    expect(screen.getByTestId("discover")).toBeDisabled();
  });
});

describe("run it", () => {
  it("needs both typed origins before Read the Company is enabled, and shows the checks after", async () => {
    mockApi({ post: { "/api/discover": json({ ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } }) } });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
    expect(screen.getByTestId("discover")).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Company origin'), { target: { value: "https://company.example" } });
    fireEvent.change(screen.getByLabelText(/Authorization server issuer/), { target: { value: "https://pf.example" } });
    expect(screen.getByTestId("discover")).toBeEnabled();
    fireEvent.click(screen.getByTestId("discover"));
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toMatch(/pass every check/));
  });
  it("shows the issuer the Company really publishes, and the checks, when the issuer does not match", async () => {
    mockApi({ post: { "/api/discover": json({ error: "issuer_mismatch", message: "The Company publishes issuer https://real-issuer.example, not the one you typed (https://other.example).", published: "https://real-issuer.example", discovery: { ok: false, checks: [{ id: "domain", ok: false, note: "organization.domain x must equal the host y" }] } }, 400) } });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
    fireEvent.change(screen.getByLabelText('Company origin'), { target: { value: "https://company.example" } });
    fireEvent.change(screen.getByLabelText(/Authorization server issuer/), { target: { value: "https://other.example" } });
    fireEvent.click(screen.getByTestId("discover"));
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toMatch(/real-issuer\.example/));
    expect(screen.getByLabelText("Discovery checks").textContent).toMatch(/organization\.domain/);
  });
  it("shows a warning check as 'warn' (not 'fail') and an unreachable host by name", async () => {
    mockApi({ state: { ...DISCOVERED, discovery: { ...DISCOVERED.discovery, checks: [{ id: "resource", ok: true, note: "resource matches" }, { id: "protected_resources", ok: false, level: "warn", note: "issuer metadata lists nothing" }] } } });
    render(<App />);
    toCalls();
    const list = await screen.findByLabelText("Discovery checks");
    expect(list.textContent).toMatch(/warn/);
    expect(list.textContent).not.toMatch(/fail/);
  });
  it("names the Company and issuer when one cannot be reached", async () => {
    mockApi({ post: { "/api/discover": json({ error: "upstream", message: "fetch failed" }, 502) } });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
    fireEvent.change(screen.getByLabelText("Company origin"), { target: { value: "https://company.example" } });
    fireEvent.change(screen.getByLabelText(/Authorization server issuer/), { target: { value: "https://pf.example" } });
    fireEvent.click(screen.getByTestId("discover"));
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toMatch(/Check https:\/\/company\.example and https:\/\/pf\.example/));
  });
  it("the resource option is off by default and is sent only when ticked", async () => {
    const authorize = vi.fn(() => json({ url: "about:blank#x", clientId: "c" }));
    mockApi({ state: DISCOVERED, post: { "/api/authorize": undefined } });
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((url, opts = {}) => (url === "/api/authorize" ? authorize(JSON.parse(opts.body)) : base(url, opts)));
    render(<App />);
    toCalls();
    const box = await screen.findByLabelText(/Send the Company as the resource/);
    expect(box).not.toBeChecked();
    await waitFor(() => expect(screen.getByTestId("signin")).toBeEnabled());
    fireEvent.click(screen.getByTestId("signin"));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ resource: false, from: "run" })));
    fireEvent.click(box);
    expect(box).toBeChecked();
    fireEvent.click(screen.getByTestId("signin"));
    await waitFor(() => expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ resource: true })));
  });
  it("enables sign-in after discovery, and the call only once signed in", async () => {
    mockApi({ state: DISCOVERED });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("signin")).toBeEnabled());
    expect(screen.getByTestId("call")).toBeDisabled();
  });
  it("renders hostile token text as text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    mockApi({ state: { ...DISCOVERED, signedIn: true, token: { access_token: evil, claims: { x: evil } } } });
    render(<App />);
    toToken();
    await waitFor(() => expect(screen.getByLabelText("Access token").textContent).toContain(evil));
    expect(document.querySelector("img")).toBeNull();
  });
  it("shows token claims through the shared pane: a Form | JSON toggle, the JSON text in full view", async () => {
    mockApi({ state: { ...DISCOVERED, signedIn: true, token: { access_token: "opaque", claims: { sub: "person-1", scope: "accounts:read" } } } });
    render(<App />);
    toToken();
    const pane = await screen.findByLabelText("Token claims");
    expect(pane.tagName).toBe("PRE");
    expect(pane.textContent).toMatch(/"sub": "person-1"/);
    const toggle = screen.getByRole("group", { name: "Token claims view" });
    expect(Array.from(toggle.querySelectorAll("button"), (b) => b.textContent)).toEqual(["Form", "JSON"]);
    fireEvent.click(toggle.querySelector("button"));
    const form = screen.getByLabelText("Token claims");
    expect(form.classList.contains("json--form")).toBe(true);
    expect(form.textContent).toMatch(/person-1/);
  });
});

describe("shell", () => {
  it("shell bar first (brand, Mock badge, nav pills, TopMenu), then <main> with the banner as its first child", async () => {
    mockApi({ info: { hosted: true, configured: false, source: "mock", realAvailable: false } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toMatch(/^HOSTED SIMULATION/));
    const bar = document.querySelector("header.shell-bar");
    expect(bar).not.toBeNull();
    expect(document.querySelector(".app").firstElementChild).toBe(bar);
    expect(bar.nextElementSibling.tagName).toBe("MAIN");
    expect(bar.querySelector(".shell-brand h1")).toHaveTextContent("Poppy Agent Tester");
    expect(bar.querySelector("[data-testid=mode-badge]")).toHaveTextContent("Mock");
    expect(bar.querySelector('.shell-nav a[aria-current="page"]')).toHaveTextContent("Run it");
    expect(bar.querySelector("[data-testid=top-menu]")).toHaveClass("shell-right");
    expect(document.querySelector("main").firstElementChild).toBe(screen.getByTestId("banner"));
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });
  it("the badge says Real when the server runs real", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-badge")).toHaveTextContent("Real"));
  });
  it("nav pills switch by click and arrow keys, and the hash follows", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Talk track" }));
    expect(window.location.hash).toBe("#talk");
    expect(screen.getByRole("link", { name: "Talk track" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("Why two headers")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("link", { name: "Talk track" }), { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: "Run it" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Talk track" })).not.toHaveAttribute("aria-current");
  });
  it("Ctrl/Cmd+P (print) does not toggle presenter mode, and Home/End move across the nav pills", async () => {
    mockApi();
    render(<App />);
    // One modifier per assertion: a combined sequence toggles on and back off and can pass with the guard removed.
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(screen.queryByTestId("presenter-say")).toBeNull();
    fireEvent.keyDown(window, { key: "P", metaKey: true });
    expect(screen.queryByTestId("presenter-say")).toBeNull();
    fireEvent.keyDown(screen.getByRole("link", { name: "Run it" }), { key: "End" });
    expect(screen.getByRole("link", { name: "Talk track" })).toHaveAttribute("aria-current", "page");
    fireEvent.keyDown(screen.getByRole("link", { name: "Talk track" }), { key: "Home" });
    expect(screen.getByRole("link", { name: "Run it" })).toHaveAttribute("aria-current", "page");
  });
  it("presenter mode shows the talk track and keeps the banner; Esc leaves it", async () => {
    mockApi();
    render(<App />);
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByTestId("presenter-say")).toBeInTheDocument();
    expect(screen.getByTestId("banner")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("presenter-say")).toBeNull();
  });
  it("Reset calls the server", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/reset", expect.objectContaining({ method: "POST" })));
  });
  it("the diagram tab loads the flow with Simulate and Reset controls", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Diagram" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /simulate/i })).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /reset/i }).length).toBeGreaterThanOrEqual(2); // the page's and the diagram's
  });
});

describe("one-click defaults", () => {
  it("pre-fills the Company origin and issuer from /api/info defaults so the visitor can 1-click run", async () => {
    const withDefaults = { hosted: false, configured: true, agentClientId: "https://agent.example/client.json", source: "real", realAvailable: true, defaults: { origin: "https://company.example", issuer: "https://pf.example:9031", scope: "accounts:read" } };
    mockApi({
      info: withDefaults,
      post: {
        "/api/discover": json({ ok: true, checks: [], poppy: { auth: { scopes: { "accounts:read": "Read" } } } }),
        "/api/authorize": json({ url: "https://pf.example:9031/as/authorization.oauth2?client_id=x" }),
      },
    });
    render(<App />);
    toCalls();
    await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
    // the form is pre-filled from the deployment's defaults
    expect(screen.getByLabelText("Company origin").value).toBe("https://company.example");
    expect(screen.getByLabelText(/Authorization server issuer/).value).toBe("https://pf.example:9031");
    // one click: discover then authorize, and the browser is sent to PingFederate
    delete window.location;
    window.location = { assign: vi.fn() };
    fireEvent.click(screen.getByTestId("one-click"));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith(expect.stringContaining("/as/authorization.oauth2")));
  });
});
