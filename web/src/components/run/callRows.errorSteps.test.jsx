// A step logged with an `error` and no request (the sign-in redirect that came back with an error, a code exchange that threw) used to
// make buildRows read `.request.url` of undefined and unmount the whole page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../App";
import { buildRows } from "./callRows";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const CFG = { origin: "https://company.example", issuer: "https://pf.example:9031", scope: "accounts:read", parEndpoint: null };
const AUTH_OK = { kind: "authorize", request: { url: "https://pf.example:9031/as/authorization.oauth2?client_id=x" } };
const AUTH_ERR = { kind: "authorize", error: "access_denied", detail: "the person said no" };
const TOKEN_ERR = { kind: "token", error: "fetch failed" };
const rowsOf = (steps) => Object.fromEntries(buildRows({ steps, config: CFG, discovery: null }).map((r) => [r.id, r]));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("buildRows with a step that has an error and no request", () => {
  it("authorize: the redirect error is the row, with its code and detail", () => {
    const r = rowsOf([AUTH_OK, AUTH_ERR]).authorize;
    expect(r.status).toBe("error");
    expect(r.tone).toBe("warn");
    expect(r.kv).toEqual([["Error", "access_denied: the person said no"]]);
    expect(r.raw).toEqual([]);
  });
  it("token: a code exchange that threw is the row, not a read of a missing request", () => {
    const r = rowsOf([TOKEN_ERR]).token;
    expect(r.status).toBe("error");
    expect(r.kv).toEqual([["Error", "fetch failed"]]);
    expect(r.raw).toEqual([]);
  });
  it("a step with a request still renders as before", () => {
    const r = rowsOf([AUTH_OK]).authorize;
    expect(r.status).toBe("browser");
    expect(r.path).toBe("/as/authorization.oauth2");
  });
});

describe("the page", () => {
  it("shows both error rows instead of going blank", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/info") return json({ hosted: false, configured: true, source: "real", realAvailable: true, defaults: {}, registered: { available: false } });
      if (url === "/api/state") return json({ workspace: "w", config: CFG, discovery: null, signedIn: false, token: null, steps: [AUTH_ERR, TOKEN_ERR] });
      if (url.startsWith("/api/story")) return json({ verticals: ["banking"], cast: {}, talkTrack: [] });
      return json({ record: null, message: "none" });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("pager-next")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pager-next"));
    await waitFor(() => expect(screen.getByTestId("row-authorize").textContent).toMatch(/error/));
    expect(screen.getByTestId("row-token").textContent).toMatch(/error/);
    expect(screen.getByRole("heading", { name: "The calls" })).toBeInTheDocument();
  });
});
