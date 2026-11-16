import { describe, expect, it } from "vitest";
import { compareKeys, keyAfter, keyForIndex } from "./ordering";

/** Sorts like Postgres `collate "C"`: by code unit, which is what the board queries use. */
const sorted = (keys: string[]) => [...keys].sort(compareKeys);

describe("compareKeys", () => {
  it("orders by code unit, so digits < upper case < lower case", () => {
    expect(sorted(["a1", "aZ", "a0", "aa", "b00"])).toEqual(["a0", "a1", "aZ", "aa", "b00"]);
    expect(compareKeys("a0", "a0")).toBe(0);
  });
});

describe("keyAfter", () => {
  it("starts an empty column and appends after the last key", () => {
    expect(keyAfter(null)).toBe("a0");
    const next = keyAfter("c00z");
    expect(compareKeys(next, "c00z")).toBeGreaterThan(0);
  });
});

describe("keyForIndex", () => {
  const column = ["a0", "a1", "a2"];

  it("gives the first key in an empty column", () => {
    expect(keyForIndex([], 0)).toBe("a0");
  });

  it("moves to the top, middle and bottom of a column", () => {
    for (const [index, expected] of [
      [0, ["new", "a0", "a1", "a2"]],
      [1, ["a0", "new", "a1", "a2"]],
      [2, ["a0", "a1", "new", "a2"]],
      [3, ["a0", "a1", "a2", "new"]],
    ] as const) {
      const key = keyForIndex(column, index);
      const order = sorted([...column, key]).map((k) => (k === key ? "new" : k));
      expect(order).toEqual(expected);
    }
  });

  it("clamps an index past the end to the bottom", () => {
    const key = keyForIndex(column, 99);
    expect(compareKeys(key, "a2")).toBeGreaterThan(0);
  });

  it("still gives a key after tied neighbours (left by concurrent writes)", () => {
    const tied = ["a0", "a1", "a1", "a2"];
    const key = keyForIndex(tied, 2);
    expect(compareKeys(key, "a1")).toBeGreaterThan(0);
    expect(compareKeys(key, "a2")).toBeLessThan(0);
    const last = keyForIndex(["a1", "a1"], 1);
    expect(compareKeys(last, "a1")).toBeGreaterThan(0);
  });

  it("keeps working after many moves into the same gap", () => {
    let low = "a0";
    const high = "a1";
    for (let i = 0; i < 200; i += 1) {
      const key = keyForIndex([low, high], 1);
      expect(compareKeys(low, key)).toBeLessThan(0);
      expect(compareKeys(key, high)).toBeLessThan(0);
      low = key;
    }
  });

  it("accepts the keys written by migration 0003", () => {
    const key = keyForIndex(["c000", "c001"], 1);
    expect(sorted(["c000", "c001", key])).toEqual(["c000", key, "c001"]);
  });
});
