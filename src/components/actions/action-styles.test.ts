import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";
import { SNOOZE_DAYS } from "@/lib/validation/reminder";
import {
  DESTRUCTIVE_ACTION,
  SECONDARY_ACTION,
  canSnooze,
  reminderMenuLabel,
  reminderName,
  snoozeLabel,
} from "./action-styles";

describe("action styles", () => {
  it("secondary actions are outlined and small", () => {
    expect(SECONDARY_ACTION).toEqual({ variant: "outline", size: "sm" });
    expect(buttonVariants(SECONDARY_ACTION)).toBe(buttonVariants({ variant: "outline", size: "sm" }));
  });

  it("destructive actions are small, bordered and red", () => {
    const classes = buttonVariants(DESTRUCTIVE_ACTION).split(" ");
    expect(DESTRUCTIVE_ACTION.size).toBe("sm");
    expect(classes).toContain("border-destructive/50");
    expect(classes).toContain("text-destructive");
    expect(classes).toContain("hover:text-destructive");
    // Never the filled look of the primary button.
    expect(classes).not.toContain("bg-primary");
  });
});

describe("reminder action copy", () => {
  it("labels every snooze choice in days", () => {
    expect(SNOOZE_DAYS.map(snoozeLabel)).toEqual(["1 day", "3 days", "7 days"]);
  });

  it("names the reminder and its ⋯ menu", () => {
    expect(reminderName("Call Ana")).toBe("reminder “Call Ana”");
    expect(reminderMenuLabel("Call Ana")).toBe("More actions for reminder “Call Ana”");
  });

  it("offers Snooze only for open reminders", () => {
    expect(canSnooze({ doneAt: null })).toBe(true);
    expect(canSnooze({ doneAt: "2025-01-01T00:00:00.000Z" })).toBe(false);
  });
});
