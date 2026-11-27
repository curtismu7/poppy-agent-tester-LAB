// The vendored shared Story code is pinned byte for byte (shared/story in AI-DEMO-Standalone). Never edit a copy.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("story vendor pin", () => {
  it("the vendored files match shared/story's recorded hashes", () => {
    const out = execFileSync("node", ["scripts/story-checkPin.mjs", "."], { cwd: "..", encoding: "utf8" });
    expect(out.trim()).toMatch(/story pin ok/);
  });
});
