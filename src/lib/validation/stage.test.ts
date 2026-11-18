import { describe, expect, it } from "vitest";
import { STAGE_CATEGORIES, parseStageInput } from "./stage";

describe("parseStageInput", () => {
  it("trims the name and accepts every category", () => {
    for (const category of STAGE_CATEGORIES) {
      expect(parseStageInput({ name: "  Take-home  ", category })).toEqual({
        success: true,
        data: { name: "Take-home", category },
      });
    }
    expect(STAGE_CATEGORIES).toEqual(["wishlist", "active", "offer", "rejected", "accepted", "withdrawn"]);
  });

  it("requires a name and a known category", () => {
    expect(parseStageInput({ name: "   ", category: "hired" })).toEqual({
      success: false,
      fieldErrors: { name: ["Name is required."], category: ["Choose a category."] },
    });
    expect(parseStageInput(null)).toEqual({
      success: false,
      fieldErrors: { name: ["Name is required."], category: ["Choose a category."] },
    });
  });

  it("limits the name to 60 characters", () => {
    expect(parseStageInput({ name: "n".repeat(61), category: "active" })).toEqual({
      success: false,
      fieldErrors: { name: ["Name must be at most 60 characters."] },
    });
    expect(parseStageInput({ name: "n".repeat(60), category: "active" })).toMatchObject({ success: true });
  });
});
