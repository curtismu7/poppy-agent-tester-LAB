import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../../App";
import { setJsonView } from "../JsonPane";
import { buildRows, decodeForm, latestSession, WHY } from "./callRows";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const CO = "https://company.example";
const PF = "https://pf.example:9031";
const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const ASSERTION = `${b64({ typ: "client-authentication+jwt", alg: "ES256", kid: "k1" })}.${b64({ iss: "https://agent.example/client.json", aud: PF, exp: 1800000060 })}.sig`;
const PAR_BODY = new URLSearchParams({ response_type: "code", client_id: "https://agent.example/client.json", scope: "accounts:read", login_hint: "demouser", client_assertion: ASSERTION }).toString();
const STEPS = [
  { kind: "discover", request: { urls: [`${CO}/.well-known/poppy.json`] }, response: { checks: [] } },
  { kind: "par", request: { method: "POST", url: `${PF}/as/par.oauth2`, body: PAR_BODY }, response: { status: 201, body: { request_uri: "urn:ietf:params:oauth:request_uri:abc", expires_in: 60 } } },
  { kind: "authorize", request: { url: `${PF}/as/authorization.oauth2?client_id=x&request_uri=urn%3Aabc` } },
  { kind: "token", request: { method: "POST", url: `${PF}/as/token.oauth2`, body: "grant_type=authorization_code" }, response: { status: 200, body: { token_type: "Bearer" } } },
  { kind: "call", request: { method: "GET", url: `${CO}/poppy/api/v1/me`, headers: { authorization: "Bearer t", "poppy-session": "s".repeat(60), "poppy-version": "1.0" }, session: { header: { typ: "poppy-session+jwt", poppy_dlg: "d" }, payload: { sub: "usr-abc123", sid: "sid-1", htm: "GET" } }, delegation: { header: { typ: "poppy-delegation+jwt" }, payload: { iss: "https://agent.example/client.json" } } }, response: { status: 200, body: { state: "signed_in", user_id: "person-1" } } },
];
const STATE = { workspace: "w", config: { origin: CO, issuer: PF, scope: "accounts:read", parEndpoint: `${PF}/as/par.oauth2` }, discovery: { ok: true, checks: [{ id: "par", ok: true, note: "issuer metadata lists a pushed_authorization_request_endpoint" }], poppy: { protocol_version: "1.0", auth: { scopes: { "accounts:read": "Read" } } }, resource: { resource: CO } }, signedIn: true, token: { access_token: "opaque", claims: { sub: "person-1", client_id: "https://agent.example/client.json" } }, steps: STEPS };

function mockApi({ state = STATE, info = { hosted: false, configured: true, agentClientId: "https://agent.example/client.json", source: "real", realAvailable: true } } = {}) {
  globalThis.fetch = vi.fn((url) => {
    if (url === "/api/info") return json(info);
    if (url === "/api/state") return json(state);
    if (url.startsWith("/api/story")) return json({ verticals: ["banking"], cast: {}, talkTrack: [] });
    return json({ error: "nope" }, 404);
  });
}

beforeEach(() => { window.location.hash = ""; window.history.replaceState(null, "", "/"); setJsonView("raw"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("buildRows", () => {
  it("lists the five calls before anything ran, with no PAR row and no status", () => {
    const rows = buildRows({ steps: [], config: null, discovery: null });
    expect(rows.map((r) => r.id)).toEqual(["poppy", "resource", "authorize", "token", "call"]);
    expect(rows.every((r) => r.status == null && r.raw.length === 0)).toBe(true);
  });
  it("adds the PAR row as soon as the issuer lists the endpoint, even before it ran", () => {
    const rows = buildRows({ steps: [], config: { origin: CO, parEndpoint: `${PF}/as/par.oauth2` }, discovery: null });
    const par = rows.find((r) => r.id === "par");
    expect(par.path).toBe("/as/par.oauth2");
    expect(par.status).toBeNull();
  });
  it("fills statuses, hosts and the Poppy-Version header from the live steps", () => {
    const rows = Object.fromEntries(buildRows(STATE).map((r) => [r.id, r]));
    expect(rows.par.status).toBe(201);
    expect(rows.par.tone).toBe("ok");
    expect(rows.authorize.status).toBe("browser");
    expect(rows.token.status).toBe(200);
    expect(rows.call.kv).toContainEqual(["Poppy-Version", "1.0"]);
    expect(rows.call.path).toBe("/poppy/api/v1/me");
    expect(rows.poppy.raw[0].value.protocol_version).toBe("1.0");
  });
  it("a form body is shown as its fields, the client assertion opened into header and claims, the exact bytes kept as sent", () => {
    const rows = Object.fromEntries(buildRows(STATE).map((r) => [r.id, r]));
    const [fields, sent] = rows.par.raw;
    expect(fields.decoded).toBe(true);
    expect(fields.value.client_id).toBe("https://agent.example/client.json");
    expect(fields.value.login_hint).toBe("demouser");
    expect(fields.value.client_assertion.header.typ).toBe("client-authentication+jwt");
    expect(fields.value.client_assertion.claims.aud).toBe(PF);
    expect(fields.value.client_assertion.jwt).toBe(ASSERTION);
    expect(sent.value).toBe(PAR_BODY);
    expect(rows.token.raw[0].value).toEqual({ grant_type: "authorization_code" });
    expect(decodeForm("client_assertion=not-a-jwt").client_assertion).toBe("not-a-jwt");
  });
  it("a refused call is a warning tone, and the newest step of a kind wins", () => {
    const later = { ...STEPS[4], response: { status: 400, body: { error: "version_unsupported" } } };
    const rows = Object.fromEntries(buildRows({ ...STATE, steps: [...STEPS, later] }).map((r) => [r.id, r]));
    expect(rows.call.status).toBe(400);
    expect(rows.call.tone).toBe("warn");
  });
  it("teaches PAR in three reasons and says plainly that this tester sends no DPoP", () => {
    expect(WHY.par).toHaveLength(3);
    expect(WHY.par.join(" ")).toMatch(/FAPI 2\.0/);
    expect(WHY.par.join(" ")).toMatch(/does not send DPoP/);
  });
  it("latestSession decodes nothing itself: it hands back what the server decoded", () => {
    expect(latestSession(STATE).payload.sid).toBe("sid-1");
    expect(latestSession({ steps: [] })).toBeNull();
  });
});

describe("the three pages", () => {
  it("one primary per page: Next on the first page, Start flow (1 click) on the calls page (Next is plain there)", async () => {
    mockApi();
    render(<App />);
    const primaries = () => [...document.querySelectorAll("main button.primary")].map((x) => x.dataset.testid);
    expect(primaries()).toEqual(["pager-next"]);
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(primaries()).toEqual(["one-click"]);
  });
  it("opens on what and why, and Next / Prev / the dots move between pages", async () => {
    mockApi();
    render(<App />);
    expect(screen.getByText(/Personal Agent Protocol . spec 1\.0/)).toBeInTheDocument();
    expect(screen.queryByTestId("one-click")).toBeNull();
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(screen.getByRole("heading", { name: "The calls" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(screen.getByRole("heading", { name: "Token & session" })).toBeInTheDocument();
    expect(screen.queryByTestId("pager-next")).toBeNull();
    fireEvent.click(screen.getByTestId("pager-prev"));
    expect(screen.getByRole("heading", { name: "The calls" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Page 1 of 3/ }));
    expect(screen.getByRole("heading", { name: /Your agent/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Page 1 of 3/ })).toHaveAttribute("aria-current", "page");
  });
  it("coming back from the authorization server (?signin=ok) lands on the calls page with the result", async () => {
    window.history.replaceState(null, "", "/?signin=ok");
    mockApi();
    render(<App />);
    expect(screen.getByRole("heading", { name: "The calls" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toMatch(/Signed in/));
  });
  it("the calls page shows each live request as a row with its reason, including PAR and the Poppy-Version header", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    await waitFor(() => expect(screen.getByTestId("row-par")).toBeInTheDocument());
    for (const id of ["poppy", "resource", "par", "authorize", "token", "call"]) expect(screen.getByTestId(`row-${id}`)).toBeInTheDocument();
    expect(within(screen.getByTestId("row-par")).getByText("201")).toBeInTheDocument();
    const call = screen.getByTestId("row-call").closest("li");
    expect(call.textContent).toMatch(/Poppy-Version/);
    expect(call.textContent).toMatch(/Why this call/);
    expect(screen.getByTestId("row-par").closest("li").textContent).toMatch(/request_uri/);
    const fields = within(screen.getByTestId("row-par").closest("li")).getByText("Request: the form fields").closest("details");
    expect(fields.open).toBe(true);
    expect(fields.textContent).toMatch(/demouser/);
  });
  it("an honest-gaps box names PingFederate, PingOne and the allow-list", () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    const box = screen.getByText(/What's missing here/).closest("div");
    expect(box.textContent).toMatch(/PingFederate:.*manual/);
    expect(box.textContent).toMatch(/PingOne:.*no CIMD/);
    expect(box.textContent).toMatch(/allow-lists/);
  });
  it("the authorization-server radios preselect the issuer the deployment configured, and a missing one is disabled", async () => {
    const info = { hosted: false, configured: true, source: "real", realAvailable: true, defaults: { origin: CO, issuer: PF, p1Issuer: "https://p1.example/as", scope: "" } };
    mockApi({ info, state: { workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] } });
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    await waitFor(() => expect(screen.getByLabelText(/Authorization server issuer/).value).toBe(PF));
    fireEvent.click(await screen.findByRole("radio", { name: /PingOne/ }));
    expect(screen.getByLabelText(/Authorization server issuer/).value).toBe("https://p1.example/as");
    fireEvent.click(screen.getByRole("radio", { name: /PingFederate/ }));
    expect(screen.getByLabelText(/Authorization server issuer/).value).toBe(PF);
    cleanup();
    mockApi({ info: { ...info, defaults: { ...info.defaults, p1Issuer: "" } }, state: { workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] } });
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(await screen.findByRole("radio", { name: /PingOne/ })).toBeDisabled();
  });
  it("the token page shows the access token claims, the Poppy-Session claims, its delegation and the four standards", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    fireEvent.click(screen.getByTestId("pager-next"));
    await screen.findByLabelText("Poppy-Session claims");
    expect(screen.getByLabelText("Poppy-Session claims").textContent).toMatch(/"sid": "sid-1"/);
    expect(screen.getByLabelText("Delegation").textContent).toMatch(/poppy-delegation\+jwt/);
    expect(screen.getByLabelText("Token claims").textContent).toMatch(/person-1/);
    for (const name of [/CIMD/, /private_key_jwt/, /Pushed Authorization Requests/, /Resource indicator/]) expect(screen.getByText(name)).toBeInTheDocument();
  });
  it("the token page names the person twice: the token's sub, and the agent's own User ID in the session", async () => {
    mockApi(); render(<App />);
    fireEvent.click(screen.getByTestId("pager-next")); fireEvent.click(screen.getByTestId("pager-next"));
    const who = await screen.findByTestId("who-is-this");
    expect(who.textContent).toMatch(/person-1/);
    expect(who.textContent).toMatch(/usr-abc123/);
    expect(who.textContent).toMatch(/random User ID/);
  });
  it("without a call yet the who-is-this note shows only the token's name for the person", async () => {
    const noCall = STEPS.filter((x) => x.kind !== "call");
    mockApi({ state: { ...STATE, steps: noCall } }); render(<App />);
    fireEvent.click(screen.getByTestId("pager-next")); fireEvent.click(screen.getByTestId("pager-next"));
    const who = await screen.findByTestId("who-is-this");
    expect(who.textContent).toMatch(/person-1/);
    expect(who.textContent).not.toMatch(/usr-/);
  });
  it("before a run the token page says what is missing instead of showing empty boxes", async () => {
    mockApi({ state: { workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] } });
    render(<App />);
    fireEvent.click(screen.getByTestId("pager-next"));
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(await screen.findByTestId("no-token")).toBeInTheDocument();
    expect(screen.getByTestId("no-session")).toBeInTheDocument();
  });
});
