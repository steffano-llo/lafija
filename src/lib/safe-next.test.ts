import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps an internal path with its query", () => {
    expect(safeNextPath("/dashboard/board?view=all")).toBe("/dashboard/board?view=all");
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative URL", "//evil.example"],
    ["backslash trick", "/\\evil.example"],
    ["relative path", "dashboard"],
    ["javascript scheme", "javascript:alert(1)"],
  ])("falls back to /dashboard for a %s target", (_label, value) => {
    expect(safeNextPath(value)).toBe("/dashboard");
  });

  it.each([
    ["dot segment", "/.//evil.example"],
    ["dot-dot segment", "/..//evil.example"],
    ["nested dot-dot", "/a/..//evil.example"],
    ["dot segment with tab", "/./\t/evil.example"],
    ["control character", "/\n/evil.example"],
  ])("falls back to /dashboard when normalization could yield an external %s target", (_label, value) => {
    expect(safeNextPath(value)).toBe("/dashboard");
  });

  it("never returns a protocol-relative path", () => {
    for (const value of ["/.//x", "/../..//x", "/a/b/../..//x", "/%2F/x", "/%5Cx", "/%2e%2e//x"]) {
      expect(safeNextPath(value).startsWith("//")).toBe(false);
    }
  });
});
