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
});
