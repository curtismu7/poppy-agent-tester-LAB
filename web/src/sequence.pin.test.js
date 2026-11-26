// The vendored sequence-diagram view (from ciba-approval-sequence-LAB) must stay byte for byte what
// scripts/sequence.sha256 pins. To update: copy the canonical lab's files again (components/, components/diagram/,
// utils/, hooks/ — see scripts/sequence-checkPin.mjs's VENDORED list), then re-pin. Never hand-edit a copy.
import { describe, expect, it } from "vitest";
import { checkPin } from "../../scripts/sequence-checkPin.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("vendored sequence-diagram view", () => {
  it("matches scripts/sequence.sha256 (an edited copy fails CI)", () => {
    expect(checkPin(root)).toEqual([]);
  });
});
