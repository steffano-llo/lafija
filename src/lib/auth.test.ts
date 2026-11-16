import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/db";
import { createAuth, getUserFromHeaders, type Auth } from "./auth";

const SECRET = "test-secret-with-at-least-thirty-two-chars";

let auth: Auth;
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
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
  return new Headers({ cookie: cookieHeader(headers) });
}

/** Turns Set-Cookie response headers into the Cookie request header a browser would send. */
function cookieHeader(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

function base64Url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const GOOGLE_TOKENS = {
  access_token: "google-access-token-plaintext",
  refresh_token: "google-refresh-token-plaintext",
};

/**
 * Runs Better Auth's real Google redirect flow: sign-in/social stores the state,
 * then the browser returns to /callback/google. Only Google's token endpoint is
 * faked (no network); the id token is unsigned because the callback only decodes it.
 */
async function googleCallback(
  profile: { sub: string; email: string; emailVerified: boolean },
  errorCallbackURL?: string,
) {
  const { headers, response } = await auth.api.signInSocial({
    body: { provider: "google", callbackURL: "/dashboard", errorCallbackURL },
    returnHeaders: true,
  });
  const state = new URL(response.url!).searchParams.get("state")!;
  const now = Math.floor(Date.now() / 1000);
  const idToken = [
    base64Url({ alg: "RS256", typ: "JWT" }),
    base64Url({
      iss: "https://accounts.google.com",
      aud: "google-client-id",
      sub: profile.sub,
      email: profile.email,
      email_verified: profile.emailVerified,
      name: "Google User",
      iat: now,
      exp: now + 3600,
    }),
    "unsigned",
  ].join(".");

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({
        ...GOOGLE_TOKENS,
        id_token: idToken,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email profile",
      });
    }
    return realFetch(input, init);
  });
  try {
    return await auth.handler(
      new Request(`http://localhost:3000/api/auth/callback/google?code=fake-code&state=${state}`, {
        headers: { cookie: cookieHeader(headers) },
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

async function accountsOf(email: string) {
  const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return db.select().from(schema.account).where(eq(schema.account.userId, owner.id));
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

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "bruno@example.com", password: "wrong-password" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().join(";")).not.toContain("session_token");

    // Sign-up opened one session and a correct sign-in opens a second; a third
    // would mean the rejected attempt stored one too.
    const headers = await signInHeaders("bruno@example.com");
    await expect(auth.api.listSessions({ headers })).resolves.toHaveLength(2);
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
    // The email is still free: a stored user would make this a duplicate (422).
    await expect(signUp("dario@example.com", "a-valid-password")).resolves.toMatchObject({
      user: { email: "dario@example.com" },
    });
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

describe("getUserFromHeaders after the session ends", () => {
  it("returns null after sign-out", async () => {
    await signUp("hugo@example.com");
    const headers = await signInHeaders("hugo@example.com");
    expect((await getUserFromHeaders(auth, headers))?.email).toBe("hugo@example.com");

    await auth.api.signOut({ headers });

    await expect(getUserFromHeaders(auth, headers)).resolves.toBeNull();
  });

  it("returns null once the session has expired", async () => {
    await signUp("ines@example.com");
    const headers = await signInHeaders("ines@example.com");
    const user = await getUserFromHeaders(auth, headers);
    expect(user?.email).toBe("ines@example.com");

    // Setup only: move the stored expiry into the past.
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.session.userId, user!.id));

    await expect(getUserFromHeaders(auth, headers)).resolves.toBeNull();
  });

  it("returns null after the user is deleted, because their sessions cascade", async () => {
    await signUp("juan@example.com");
    const headers = await signInHeaders("juan@example.com");
    const user = await getUserFromHeaders(auth, headers);
    expect(user?.email).toBe("juan@example.com");

    await db.delete(schema.user).where(eq(schema.user.id, user!.id));

    await expect(
      db.select().from(schema.session).where(eq(schema.session.userId, user!.id)),
    ).resolves.toEqual([]);
    await expect(getUserFromHeaders(auth, headers)).resolves.toBeNull();
  });
});

describe("Google sign-in", () => {
  it("creates a new user and stores Google tokens encrypted, not in plaintext", async () => {
    const response = await googleCallback({
      sub: "google-sub-new",
      email: "nora@example.com",
      emailVerified: true,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    const headers = new Headers({ cookie: cookieHeader(response.headers) });
    expect((await getUserFromHeaders(auth, headers))?.email).toBe("nora@example.com");

    const [google] = await accountsOf("nora@example.com");
    expect(google.providerId).toBe("google");
    expect(google.accessToken).toEqual(expect.any(String));
    expect(google.accessToken).not.toContain(GOOGLE_TOKENS.access_token);
    expect(google.refreshToken).toEqual(expect.any(String));
    expect(google.refreshToken).not.toContain(GOOGLE_TOKENS.refresh_token);
    // The id token is not needed after sign-in and Better Auth does not encrypt it.
    expect(google.idToken).toBeNull();

    // The app can still read the token back through Better Auth.
    await expect(
      auth.api.getAccessToken({ body: { accountId: google.id }, headers }),
    ).resolves.toMatchObject({ accessToken: GOOGLE_TOKENS.access_token });
  });

  it.each([
    { localEmailVerified: false, label: "an unverified" },
    { localEmailVerified: true, label: "a verified" },
  ])(
    "never attaches to $label email/password account with the same email",
    async ({ localEmailVerified }) => {
      const email = `owner-${localEmailVerified}@example.com`;
      await signUp(email, "owner-password");
      // Setup only: the app has no email verification flow yet; this covers a future one.
      await db
        .update(schema.user)
        .set({ emailVerified: localEmailVerified })
        .where(eq(schema.user.email, email));

      const response = await googleCallback({
        sub: `google-sub-${localEmailVerified}`,
        email,
        emailVerified: true,
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/sign-in?error=account_not_linked",
      );
      expect(response.headers.getSetCookie().join(";")).not.toContain("session_token");
      expect((await accountsOf(email)).map((account) => account.providerId)).toEqual([
        "credential",
      ]);
      await expect(signInHeaders(email, "owner-password")).resolves.toBeInstanceOf(Headers);
    },
  );

  it("returns a refused Google sign-in to the error URL the sign-in form sends", async () => {
    await signUp("olga@example.com");

    const response = await googleCallback(
      { sub: "google-sub-olga", email: "olga@example.com", emailVerified: true },
      "/sign-in?next=%2Fdashboard",
    );

    expect(response.headers.get("location")).toBe("/sign-in?next=%2Fdashboard&error=account_not_linked");
  });
});

describe("test database", () => {
  it("finds its migrations regardless of the working directory", async () => {
    const original = process.cwd();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "lafija-cwd-"));
    try {
      process.chdir(elsewhere);
      const other = await createTestDb();
      await expect(other.db.select().from(schema.user)).resolves.toEqual([]);
      await other.close();
    } finally {
      process.chdir(original);
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

describe("Google sign-in for a returning user", () => {
  it("signs in again without storing the id token or plaintext tokens", async () => {
    const profile = { sub: "google-sub-ret", email: "ret@example.com", emailVerified: true };
    await googleCallback(profile);
    const second = await googleCallback(profile);

    expect(second.headers.get("location")).toBe("/dashboard");
    const headers = new Headers({ cookie: cookieHeader(second.headers) });
    expect((await getUserFromHeaders(auth, headers))?.email).toBe("ret@example.com");
    const accounts = await accountsOf("ret@example.com");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].idToken).toBeNull();
    expect(accounts[0].accessToken).not.toContain(GOOGLE_TOKENS.access_token);
  });

  it("refuses a case-variant Google email for an existing account", async () => {
    await signUp("case@example.com", "owner-password");
    const result = await googleCallback({ sub: "google-sub-case", email: "CASE@Example.com", emailVerified: true });

    expect(result.headers.get("location")).toBe("http://localhost:3000/sign-in?error=account_not_linked");
    expect((await accountsOf("case@example.com")).map((account) => account.providerId)).toEqual(["credential"]);
  });

  it("does not let email sign-up claim a Google user's email", async () => {
    await googleCallback({ sub: "google-sub-g1", email: "g1@example.com", emailVerified: true });

    await expect(signUp("g1@example.com", "attacker-pass")).rejects.toMatchObject({ statusCode: 422 });
  });
});
