import { describe, expect, it } from "vitest";
import { labelOffsets } from "./PatternDiagram";

describe("labelOffsets", () => {
  it("gives every step on one pair of boxes its own slot, in either direction", () => {
    const steps = [{ from: "a", to: "c" }, { from: "c", to: "a" }, { from: "a", to: "p" }, { from: "p", to: "a" }, { from: "a", to: "c" }, { from: "c", to: "a" }];
    const o = labelOffsets(steps);
    const ac = [o[0], o[1], o[4], o[5]];
    expect(new Set(ac).size).toBe(4);
    expect(ac).toEqual([-39, -13, 13, 39]);
    expect([o[2], o[3]]).toEqual([-13, 13]);
  });
  it("leaves a single step on the centre line", () => {
    expect(labelOffsets([{ from: "a", to: "b" }])).toEqual([0]);
  });
});
