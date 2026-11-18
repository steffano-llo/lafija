import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { createAuth, type Auth } from "./auth";

const request = vi.hoisted(() => ({ headers: new Headers(), auth: undefined as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/navigation", () => ({
  // Like Next.js, redirect() never returns: it throws to stop rendering.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  getAuth: () => request.auth,
}));

const { redirect } = await import("next/navigation");
const { getCurrentUser, requireUser } = await import("./session");

let auth: Auth;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  auth = createAuth({
    db: testDb.db,
    secret: "test-secret-with-at-least-thirty-two-chars",
    baseURL: "http://localhost:3000",
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
  });
  request.auth = auth;
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  request.headers = new Headers();
  vi.mocked(redirect).mockClear();
});

async function signedInHeaders(email: string) {
  await auth.api.signUpEmail({ body: { name: "Test", email, password: "correct-horse-battery" } });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: "correct-horse-battery" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

describe("getCurrentUser", () => {
  it("returns null without a session", async () => {
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns the verified user for a valid session", async () => {
    request.headers = await signedInHeaders("lia@example.com");

    await expect(getCurrentUser()).resolves.toMatchObject({ email: "lia@example.com" });
  });
});

describe("requireUser", () => {
  it("redirects to /sign-in without a session", async () => {
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT /sign-in");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/sign-in");
  });

  it("redirects to /sign-in for a forged session cookie", async () => {
    request.headers = new Headers({ cookie: "better-auth.session_token=forged.value" });

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT /sign-in");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/sign-in");
  });

  it("redirects to /sign-in after the session is signed out", async () => {
    request.headers = await signedInHeaders("mia@example.com");
    await auth.api.signOut({ headers: request.headers });

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT /sign-in");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/sign-in");
  });

  it("returns the verified user for a valid session without redirecting", async () => {
    request.headers = await signedInHeaders("noa@example.com");

    await expect(requireUser()).resolves.toMatchObject({ email: "noa@example.com" });
    expect(redirect).not.toHaveBeenCalled();
  });
});
