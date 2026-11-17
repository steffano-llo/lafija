import { describe, expect, it } from "vitest";
import { normalizeSource, presetSource, SOURCE_PRESETS, sourceSuggestions } from "./source";

describe("normalizeSource (S20)", () => {
  it("trims and collapses inner whitespace; blank becomes null", () => {
    expect(normalizeSource("  Get   on \t Board ")).toBe("Get on Board");
    expect(normalizeSource("LinkedIn")).toBe("LinkedIn");
    expect(normalizeSource("   ")).toBeNull();
    expect(normalizeSource("")).toBeNull();
  });
});

describe("presetSource", () => {
  it("returns the preset spelling for a case-insensitive match, else undefined", () => {
    expect(presetSource("linkedin")).toBe("LinkedIn");
    expect(presetSource("GET ON BOARD")).toBe("Get on Board");
    expect(presetSource("referido")).toBe("Referido");
    expect(presetSource("Linked In")).toBeUndefined();
  });

  it("lists the six presets", () => {
    expect(SOURCE_PRESETS).toEqual(["LinkedIn", "Computrabajo", "Bumeran", "Get on Board", "Indeed", "Referido"]);
  });
});

describe("sourceSuggestions", () => {
  it("puts the user's forms first, then the presets, without case-insensitive duplicates", () => {
    expect(sourceSuggestions(["Referral", "LINKEDIN", "referral", "Indeed"])).toEqual([
      "Referral",
      "LINKEDIN",
      "Indeed",
      "Computrabajo",
      "Bumeran",
      "Get on Board",
      "Referido",
    ]);
  });

  it("is just the presets for a user without sources", () => {
    expect(sourceSuggestions([])).toEqual([...SOURCE_PRESETS]);
  });
});
