import { describe, expect, it } from "vitest";
import { formatTimeLeft } from "./format";

describe("formatTimeLeft", () => {
  it.each([
    [24 * 60 * 60_000, "24 h 0 min left"],
    [(23 * 60 + 5) * 60_000 + 59_000, "23 h 5 min left"],
    [45 * 60_000, "45 min left"],
    [59_999, "less than a minute left"],
    [-5_000, "less than a minute left"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });
});
