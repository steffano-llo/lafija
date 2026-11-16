import { describe, expect, it } from "vitest";
import { parseMoveInput } from "./board";

describe("parseMoveInput", () => {
  it("accepts ids and a non-negative integer index", () => {
    expect(parseMoveInput({ applicationId: "a", stageId: "s", index: 0 })).toEqual({
      success: true,
      data: { applicationId: "a", stageId: "s", index: 0 },
    });
  });

  it("refuses anything else", () => {
    for (const input of [
      undefined,
      null,
      "x",
      { applicationId: "a", stageId: "s" },
      { applicationId: "", stageId: "s", index: 0 },
      { applicationId: 1, stageId: "s", index: 0 },
      { applicationId: "a", stageId: ["s"], index: 0 },
      { applicationId: "a", stageId: "s", index: -1 },
      { applicationId: "a", stageId: "s", index: 1.5 },
      { applicationId: "a", stageId: "s", index: "1" },
      { applicationId: "a", stageId: "s", index: Number.POSITIVE_INFINITY },
      { applicationId: "a".repeat(101), stageId: "s", index: 0 },
    ]) {
      expect(parseMoveInput(input)).toEqual({ success: false });
    }
  });
});
