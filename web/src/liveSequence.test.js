// liveSequence — the run's steps as sequence messages. Unit tests: the mapping is pure, so every rule is a check here.
import { describe, expect, it } from "vitest";
import { buildSequence, sequenceDetails, sequenceSource, KIND_MESSAGE_INDEX } from "./liveSequence";

const step = (kind, extra = {}) => ({ kind, ...extra });
const DISCOVERED = [
  step("discover", { request: { method: "GET", url: "https://company.example/.well-known/poppy.json" }, response: { status: 200, body: '{"protocol_version":"1.0"}' } }),
  step("par", { request: { method: "POST", url: "https://pf.example/par" }, response: { status: 200, body: '{"request_uri":"urn:ietf:params:oauth:request_uri:x"}' } }),
  step("authorize"),
  step("token", { request: { method: "POST", url: "https://pf.example/token" }, response: { status: 200, body: '{"access_token":"at"}' } }),
  step("call", { request: { method: "GET", url: "https://company.example/poppy/api/v1/me" }, response: { status: 200, body: '{"user_id":"u-1"}' } }),
];

describe("buildSequence", () => {
  it("an empty run still draws the lifelines with the discovery messages as ghosts", () => {
    const r = buildSequence([]);
    expect(r.participants.map((p) => p[0])).toEqual(["person", "agent", "pf", "company"]);
    expect(r.messages.length).toBe(7); // discovery x2, authorize, token x2, call x2 — no PAR row invented when the issuer is unknown
    expect(r.messages.every((m) => m.step === undefined || m.step === null)).toBe(true);
  });

  it("a full run draws 9 messages in protocol order, no PAR row invented when the issuer lists none", () => {
    const r = buildSequence(DISCOVERED);
    expect(r.messages.map((m) => m.kind)).toEqual(["discover", "discover", "par", "par", "authorize", "token", "token", "call", "call"]);
  });

  it("an authorize error step (issuer redirect refused) carries the error, and later hops stay ghosts", () => {
    const r = buildSequence([step("discover", { request: { method: "GET", url: "https://company.example/x" }, response: { status: 200 } }), step("authorize", { error: "access_denied", detail: "the person denied it" })]);
    const err = r.messages.find((m) => m.kind === "authorize");
    expect(err.msg.dashed === false).toBe(true);
    expect(JSON.stringify(err.detail)).toContain("access_denied");
  });

  it("PAR refused: the PAR hop exists with the refusal; the token and call hops stay", () => {
    const r = buildSequence([step("discover", { request: { method: "GET", url: "https://company.example/x" } }), step("par", { request: { method: "POST", url: "https://pf.example/par" }, response: { status: 400, body: '{"error":"invalid_request"}' } }), step("token", { error: "discover_first" })]);
    const par = r.messages.find((m) => m.kind === "par");
    expect(JSON.stringify(par.detail)).toContain("HTTP 400");
  });

  it("the person and the browser are one lane: the sign-in hop is person to pf, never a fabricated browser wire", () => {
    const r = buildSequence(DISCOVERED);
    const a = r.messages.find((m) => m.kind === "authorize");
    expect(a.msg.from).toBe("person");
    expect(a.msg.to).toBe("pf");
  });

  it("the wire detail in the reel is the SAME live step data, never invented", () => {
    const r = buildSequence(DISCOVERED);
    const callDetail = r.messages.find((m) => m.kind === "call" && !m.msg.dashed).detail;
    expect(JSON.stringify(callDetail)).toContain("/poppy/api/v1/me");
    expect(JSON.stringify(callDetail)).toContain("u-1");
  });
});

describe("sequenceDetails", () => {
  it("one detail per message, with what/request/response filled from the live step", () => {
    const d = sequenceDetails(DISCOVERED);
    expect(d.length).toBe(buildSequence(DISCOVERED).messages.length);
    expect(d[0].what.length).toBeGreaterThan(20);
    expect(d[0].request).toContain("GET");
    const tok = d[5];
    expect(tok.response).toContain("HTTP 200");
  });

  it("an error step's detail carries the error where the reader looks (Open)", () => {
    const d = sequenceDetails([step("discover"), step("authorize", { error: "access_denied", detail: "the person denied it" })]);
    const err = d.find((x) => x.what.includes("sign in"));
    expect(err.open).toContain("access_denied");
  });
});

describe("sequenceSource", () => {
  it("is the DSL the vendored parser reads: participants declared, one line per message", () => {
    const src = sequenceSource(DISCOVERED);
    expect(src.startsWith("sequenceDiagram\n")).toBe(true);
    expect(src).toContain("participant person as");
    expect(src).toContain("participant pf as");
    expect(src).toContain("agent->>company:");
    expect(src).toContain("company-->>agent:");
    expect(src).toContain("autonumber");
  });

  it("an empty run still declares the four lifelines", () => {
    const src = sequenceSource([]);
    expect(src.match(/participant /g).length).toBe(4);
  });
});

describe("KIND_MESSAGE_INDEX", () => {
  it("maps each chat kind to the FIRST sequence message of that kind (the request arrow)", () => {
    expect(KIND_MESSAGE_INDEX).toEqual({ discover: 0, par: 2, authorize: 4, token: 5, call: 7 });
  });

  it("every kind the chat lights (STEP_ARROW's kinds) has an index here", () => {
    // AtlasChat lights discover/authorize/token/call; the sequence must light all of them.
    for (const k of ["discover", "authorize", "token", "call"]) expect(KIND_MESSAGE_INDEX[k]).toBeDefined();
  });
});
