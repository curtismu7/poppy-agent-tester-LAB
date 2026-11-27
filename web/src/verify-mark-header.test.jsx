import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import App from "./App";

// The header shows this lab's own Verified / In progress mark, read from GET /api/shelf (the call ShelfLink makes in other labs). Through the
// lab-proxy that call reaches the shelf, whose payload lists every demo with its mark. On its own port the lab answers with only { shelfUrl }.
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });

function mockApi(shelf) {
  globalThis.fetch = vi.fn((url) => {
    if (url === "/api/shelf") return shelf === "down" ? Promise.reject(new Error("down")) : json(shelf);
    if (url === "/api/info") return json({ hosted: false, configured: true, agentClientId: "https://agent.example/client.json", source: "mock", realAvailable: false });
    if (url === "/api/state") return json({ workspace: "w", config: null, discovery: null, signedIn: false, token: null, steps: [] });
    if (url.startsWith("/api/cast")) return json({ verticals: ["banking"], cast: {}, talkTrack: [] });
    if (url === "/api/sample") return json({ note: "EXAMPLE run: invented", steps: [] });
    if (url.startsWith("/api/diagram")) return json({ title: "t", intro: "i", nodes: [], steps: [] });
    return json({ error: "nope" }, 404);
  });
}

beforeEach(() => { window.location.hash = ""; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("verification mark in the header", () => {
  it("shows this lab's own mark inside the top menu, and no other lab's", async () => {
    mockApi({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "poppy-demo", verification: mark("verified", "Verified", { note: "Every step run on the mock" }) }] });
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every step run on the mock"));
  });

  it("shows nothing without a mark, when /api/shelf has only { shelfUrl }, or when the shelf is unreachable", async () => {
    for (const shelf of [{ shelfUrl: "http://shelf.example", demos: [{ id: "poppy-demo", verification: null }] }, { shelfUrl: "http://shelf.example" }, "down"]) {
      mockApi(shelf);
      const { unmount } = render(<App />);
      await screen.findByTestId("top-menu");
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/shelf", expect.anything()));
      await new Promise((r) => setTimeout(r, 30));
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });

  it("fails when the line is removed from App.jsx (the badge needs the lab's own shelf id)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");
    expect(src.match(/<VerifyMark id="poppy-demo" \/>/g)).toHaveLength(1);
    const shelf = JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "docs", "shelf-entry.json"), "utf8"));
    expect(shelf.demos[0].id).toBe("poppy-demo");
  });
});
