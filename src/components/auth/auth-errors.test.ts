import { describe, expect, it, vi } from "vitest";
import { runAuthRequest, signInErrorMessage, signOutAndLeave } from "./auth-errors";

describe("signInErrorMessage", () => {
  it("explains that Google was refused for an existing email account", () => {
    expect(signInErrorMessage("account_not_linked")).toBe(
      "An account with this email already exists. Sign in with your email and password.",
    );
  });

  it("explains that Google was refused for an address in the reserved demo domain", () => {
    expect(signInErrorMessage("EMAIL_DOMAIN_RESERVED")).toBe("This email domain is reserved.");
  });

  it("falls back to a generic message for other codes", () => {
    expect(signInErrorMessage("state_mismatch")).toBe("Sign-in failed. Please try again.");
  });

  it("returns null without a code", () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("")).toBeNull();
  });
});

describe("runAuthRequest", () => {
  it("returns null when the request succeeds", async () => {
    await expect(runAuthRequest(async () => ({ error: null }), "Fallback.")).resolves.toBeNull();
  });

  it("returns the server message when the request reports an error", async () => {
    await expect(
      runAuthRequest(async () => ({ error: { message: "Invalid email or password" } }), "Fallback."),
    ).resolves.toBe("Invalid email or password");
  });

  it("returns the fallback when the error has no message", async () => {
    await expect(runAuthRequest(async () => ({ error: {} }), "Fallback.")).resolves.toBe("Fallback.");
  });

  it("returns the fallback when the request throws", async () => {
    await expect(
      runAuthRequest(async () => {
        throw new TypeError("Failed to fetch");
      }, "Fallback."),
    ).resolves.toBe("Fallback.");
  });
});

describe("signOutAndLeave", () => {
  it("leaves after a successful sign-out", async () => {
    const leave = vi.fn();

    await expect(signOutAndLeave(async () => ({ error: null }), leave)).resolves.toBeNull();
    expect(leave).toHaveBeenCalledOnce();
  });

  it("stays and reports an error when sign-out returns an error", async () => {
    const leave = vi.fn();

    await expect(
      signOutAndLeave(async () => ({ error: { message: "Server unavailable" } }), leave),
    ).resolves.toBe("Could not sign out. Please try again.");
    expect(leave).not.toHaveBeenCalled();
  });

  it("stays and reports an error when sign-out throws", async () => {
    const leave = vi.fn();

    await expect(
      signOutAndLeave(async () => {
        throw new TypeError("Failed to fetch");
      }, leave),
    ).resolves.toBe("Could not sign out. Please try again.");
    expect(leave).not.toHaveBeenCalled();
  });
});
