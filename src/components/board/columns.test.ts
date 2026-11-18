import { describe, expect, it } from "vitest";
import { findColumn, locate, moveCard, type Columns } from "./columns";

const columns: Columns = { s1: ["a", "b", "c"], s2: ["x"], s3: [] };

describe("board columns", () => {
  it("finds the column of a card or a column id", () => {
    expect(findColumn(columns, "b")).toBe("s1");
    expect(findColumn(columns, "s3")).toBe("s3");
    expect(findColumn(columns, "missing")).toBeUndefined();
    expect(locate(columns, "c")).toEqual({ column: "s1", index: 2 });
    expect(locate(columns, "s1")).toBeUndefined();
  });

  it("reorders within a column", () => {
    expect(moveCard(columns, "c", "a")).toEqual({ ...columns, s1: ["c", "a", "b"] });
    expect(moveCard(columns, "a", "c")).toEqual({ ...columns, s1: ["b", "c", "a"] });
    expect(moveCard(columns, "a", "a")).toBe(columns);
  });

  it("moves to another column at a card's place or to the bottom of a column", () => {
    expect(moveCard(columns, "b", "x")).toEqual({ s1: ["a", "c"], s2: ["b", "x"], s3: [] });
    expect(moveCard(columns, "b", "s2")).toEqual({ s1: ["a", "c"], s2: ["x", "b"], s3: [] });
    expect(moveCard(columns, "b", "s3")).toEqual({ s1: ["a", "c"], s2: ["x"], s3: ["b"] });
  });

  it("ignores unknown ids", () => {
    expect(moveCard(columns, "missing", "s2")).toBe(columns);
    expect(moveCard(columns, "a", "missing")).toBe(columns);
  });
});
