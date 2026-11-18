import { describe, expect, it } from "vitest";
import type { EmailConfig, EmailState } from "@/lib/env";
import {
  emailProblemMessage,
  isAddressAllowed,
  reminderEmailProblems,
  verificationEmailBlocker,
  verificationBlockerMessage,
} from "./eligibility";

const config = (addresses: string[] | "*"): EmailConfig => ({
  currentSigningKey: "cur",
  nextSigningKey: "next",
  resendApiKey: "re_1",
  from: "laFija <onboarding@resend.dev>",
  recipients: addresses === "*" ? { everyone: true, addresses: [] } : { everyone: false, addresses },
  appUrl: "https://lafija.example",
  cronUrl: "https://lafija.example/api/cron/reminders",
});
const NOT_CONFIGURED: EmailState = { ok: false, reason: "not_configured", missing: ["RESEND_API_KEY"] };
const MISCONFIGURED: EmailState = { ok: false, reason: "misconfigured", keys: ["EMAIL_FROM"] };
const EMAIL = "Me@Example.com";

describe("isAddressAllowed", () => {
  it("allows everyone with *, listed addresses ignoring case, and nobody with an empty list", () => {
    expect(isAddressAllowed({ everyone: true, addresses: [] }, EMAIL)).toBe(true);
    expect(isAddressAllowed({ everyone: false, addresses: ["me@example.com"] }, EMAIL)).toBe(true);
    expect(isAddressAllowed({ everyone: false, addresses: ["other@example.com"] }, EMAIL)).toBe(false);
    expect(isAddressAllowed({ everyone: false, addresses: [] }, EMAIL)).toBe(false);
  });
});

describe("reminderEmailProblems: the S17 recipient rule", () => {
  const states: [string, EmailState][] = [
    ["configured, *", { ok: true, config: config("*") }],
    ["configured, listed", { ok: true, config: config(["me@example.com"]) }],
    ["configured, not listed", { ok: true, config: config(["other@example.com"]) }],
    ["not configured", NOT_CONFIGURED],
    ["misconfigured", MISCONFIGURED],
  ];
  const cases = states.flatMap(([label, state]) =>
    [true, false].flatMap((emailVerified) =>
      [true, false].map((emailReminders) => ({ label, state, emailVerified, emailReminders })),
    ),
  );

  it.each(cases)(
    "$label, verified=$emailVerified, switch=$emailReminders",
    ({ label, state, emailVerified, emailReminders }) => {
      const expected = [
        ...(label === "not configured" ? ["not_configured"] : []),
        ...(label === "misconfigured" ? ["misconfigured"] : []),
        ...(emailVerified ? [] : ["unverified"]),
        ...(emailReminders ? [] : ["switched_off"]),
        ...(label === "configured, not listed" ? ["not_allowed"] : []),
      ];

      expect(reminderEmailProblems({ state, email: EMAIL, emailVerified, emailReminders })).toEqual(expected);
    },
  );

  it("does not let a listed address bypass verification", () => {
    expect(
      reminderEmailProblems({
        state: { ok: true, config: config(["me@example.com"]) },
        email: EMAIL,
        emailVerified: false,
        emailReminders: true,
      }),
    ).toEqual(["unverified"]);
  });

  it("explains every problem in English without naming keys or the allowlist", () => {
    expect(emailProblemMessage("not_configured")).toBe("Email delivery is not set up for laFija.");
    expect(emailProblemMessage("misconfigured")).toBe(
      "Email delivery is unavailable: its configuration is invalid.",
    );
    expect(emailProblemMessage("unverified")).toBe("Your email address is not verified yet.");
    expect(emailProblemMessage("switched_off")).toBe("“Email me due reminders” is off.");
    expect(emailProblemMessage("not_allowed")).toBe(
      "Email delivery is limited while laFija has no domain, and your address is not one of the allowed recipients.",
    );
  });
});

describe("verificationEmailBlocker", () => {
  it("blocks when delivery is not configured, misconfigured or the address is not allowed", () => {
    expect(verificationEmailBlocker(NOT_CONFIGURED, EMAIL)).toBe("not_configured");
    expect(verificationEmailBlocker(MISCONFIGURED, EMAIL)).toBe("misconfigured");
    expect(verificationEmailBlocker({ ok: true, config: config(["other@example.com"]) }, EMAIL)).toBe("not_allowed");
    expect(verificationEmailBlocker({ ok: true, config: config(["me@example.com"]) }, EMAIL)).toBeNull();
    expect(verificationEmailBlocker({ ok: true, config: config("*") }, EMAIL)).toBeNull();
  });

  it("explains the blocker plainly", () => {
    expect(verificationBlockerMessage("not_configured")).toBe(
      "Email delivery is not set up for laFija, so the verification email cannot be sent.",
    );
    expect(verificationBlockerMessage("misconfigured")).toBe(
      "Email delivery is unavailable right now, so the verification email cannot be sent.",
    );
    expect(verificationBlockerMessage("not_allowed")).toBe(
      "Email delivery is limited while laFija has no domain, so the verification email cannot be sent to your address.",
    );
  });
});
