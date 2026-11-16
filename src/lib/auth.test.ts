import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";
import { createAuth, getUserFromHeaders, type Auth } from "./auth";

const SECRET = "test-secret-with-at-least-thirty-two-chars";

let auth: Auth;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  auth = createAuth({
    db: testDb.db,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
  });
});

afterAll(async () => {
  await close();
});

async function signUp(email: string, password = "correct-horse-battery") {
  return auth.api.signUpEmail({ body: { name: email.split("@")[0], email, password } });
}

/** Signs in and returns request headers carrying the session cookie, like a browser would. */
async function signInHeaders(email: string, password = "correct-horse-battery") {
  const { headers } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

describe("email and password auth", () => {
  it("signs up a new user and signs them in", async () => {
    const result = await signUp("ana@example.com");

    expect(result.user.email).toBe("ana@example.com");
    expect(result.token).toEqual(expect.any(String));

    const headers = await signInHeaders("ana@example.com");
    const user = await getUserFromHeaders(auth, headers);
    expect(user?.email).toBe("ana@example.com");
  });

  it("rejects a wrong password and creates no session", async () => {
    await signUp("bruno@example.com");

    await expect(
      auth.api.signInEmail({ body: { email: "bruno@example.com", password: "wrong-password" } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a duplicate email and keeps the original credentials", async () => {
    await signUp("carla@example.com", "original-password");

    await expect(signUp("carla@example.com", "another-password")).rejects.toMatchObject({
      statusCode: 422,
    });

    await expect(signInHeaders("carla@example.com", "original-password")).resolves.toBeInstanceOf(
      Headers,
    );
    await expect(
      auth.api.signInEmail({ body: { email: "carla@example.com", password: "another-password" } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects passwords shorter than 8 characters and creates no user", async () => {
    await expect(signUp("dario@example.com", "1234567")).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(
      auth.api.signInEmail({ body: { email: "dario@example.com", password: "1234567" } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("getUserFromHeaders", () => {
  it("returns null without a session cookie", async () => {
    await expect(getUserFromHeaders(auth, new Headers())).resolves.toBeNull();
  });

  it("returns null for a forged session cookie", async () => {
    const headers = new Headers({ cookie: "better-auth.session_token=forged.value" });

    await expect(getUserFromHeaders(auth, headers)).resolves.toBeNull();
  });

  it("returns null for a validly signed cookie whose value was tampered with", async () => {
    await signUp("gabi@example.com");
    const cookie = (await signInHeaders("gabi@example.com")).get("cookie")!;
    const tampered = cookie.replace(/=(.)/, (_match, first: string) => `=${first === "a" ? "b" : "a"}`);

    expect(tampered).not.toBe(cookie);
    await expect(getUserFromHeaders(auth, new Headers({ cookie: tampered }))).resolves.toBeNull();
  });

  it("returns only the user that owns the session", async () => {
    await signUp("eva@example.com");
    await signUp("fede@example.com");

    const evaHeaders = await signInHeaders("eva@example.com");
    const fedeHeaders = await signInHeaders("fede@example.com");

    expect((await getUserFromHeaders(auth, evaHeaders))?.email).toBe("eva@example.com");
    expect((await getUserFromHeaders(auth, fedeHeaders))?.email).toBe("fede@example.com");
  });
});

describe("social providers", () => {
  it("offers Google sign-in with a redirect to Google's consent screen", async () => {
    const result = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: "/dashboard" },
    });

    expect(result.redirect).toBe(true);
    expect(new URL(result.url!).hostname).toBe("accounts.google.com");
    expect(new URL(result.url!).searchParams.get("client_id")).toBe("google-client-id");
  });
});
