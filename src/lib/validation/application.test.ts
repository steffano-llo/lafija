import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApplicationInput } from "./application";

const valid = { companyName: "Acme", role: "Frontend Engineer" };

afterEach(() => {
  vi.useRealTimers();
});

describe("parseApplicationInput", () => {
  it("trims text and turns empty optional fields into null", () => {
    expect(
      parseApplicationInput({
        companyName: "  Acme  ",
        role: " Frontend Engineer ",
        url: "  ",
        source: "",
        salaryRange: " 50k-60k ",
        salaryCurrency: "USD",
        appliedAt: "",
      }),
    ).toEqual({
      success: true,
      data: {
        companyName: "Acme",
        role: "Frontend Engineer",
        url: null,
        source: null,
        salaryRange: "50k-60k",
        salaryCurrency: "USD",
        appliedAt: null,
      },
    });
  });

  it("accepts missing optional fields", () => {
    expect(parseApplicationInput(valid)).toEqual({
      success: true,
      data: { ...valid, url: null, source: null, salaryRange: null, salaryCurrency: null, appliedAt: null },
    });
  });

  it("requires company and role", () => {
    expect(parseApplicationInput({ companyName: "   " })).toEqual({
      success: false,
      fieldErrors: { companyName: ["Company is required."], role: ["Role is required."] },
    });
    expect(parseApplicationInput(null)).toMatchObject({ success: false });
  });

  it("limits text lengths", () => {
    expect(
      parseApplicationInput({
        companyName: "a".repeat(121),
        role: "r".repeat(121),
        source: "s".repeat(81),
        salaryRange: "$".repeat(81),
        url: `https://example.com/${"p".repeat(2048)}`,
      }),
    ).toEqual({
      success: false,
      fieldErrors: {
        companyName: ["Company must be at most 120 characters."],
        role: ["Role must be at most 120 characters."],
        source: ["Source must be at most 80 characters."],
        salaryRange: ["Salary range must be at most 80 characters."],
        url: ["URL must be at most 2048 characters."],
      },
    });
    expect(parseApplicationInput({ companyName: "a".repeat(120), role: "r".repeat(120) })).toMatchObject({
      success: true,
    });
  });

  it.each(["ftp://example.com", "javascript:alert(1)", "example.com/jobs", "https://", "http:example.com"])(
    "rejects the non-http(s) URL %s",
    (url) => {
      expect(parseApplicationInput({ ...valid, url })).toEqual({
        success: false,
        fieldErrors: { url: ["Enter a valid http(s) URL."] },
      });
    },
  );

  it.each(["https://acme.com/jobs/1", "http://localhost:3000/x?y=1", "HTTPS://ACME.COM"])("accepts the URL %s", (url) => {
    expect(parseApplicationInput({ ...valid, url })).toMatchObject({ success: true, data: { url } });
  });

  it.each(["2024-02-30", "2024-13-01", "yesterday", "2024-1-5", "20240105"])("rejects the invalid date %s", (appliedAt) => {
    expect(parseApplicationInput({ ...valid, appliedAt })).toEqual({
      success: false,
      fieldErrors: { appliedAt: ["Enter a valid date."] },
    });
  });

  it("accepts today and leap days, rejects future dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 12:00 UTC on June 15 is already June 16 in UTC+14.
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));

    expect(parseApplicationInput({ ...valid, appliedAt: "2024-06-15" })).toMatchObject({ success: true });
    expect(parseApplicationInput({ ...valid, appliedAt: "2024-02-29" })).toMatchObject({ success: true });
    // Users ahead of UTC (up to UTC+14) may already be on the next calendar day.
    expect(parseApplicationInput({ ...valid, appliedAt: "2024-06-16" })).toMatchObject({ success: true });
    expect(parseApplicationInput({ ...valid, appliedAt: "2024-06-17" })).toEqual({
      success: false,
      fieldErrors: { appliedAt: ["Applied date cannot be in the future."] },
    });
  });
});
