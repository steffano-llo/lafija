import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import * as schema from "@/db/schema";
import { getDb } from "@/db";
import { createResendMailer } from "@/lib/email/resend-sender";
import {
  createSendVerificationEmail,
  VERIFICATION_LINK_HOURS,
  type VerificationDelivery,
} from "@/lib/email/verification";
import { getEmailState, getEnv } from "@/lib/env";
import { isDemoEmail } from "@/lib/validation/demo";
import type { Db } from "@/server/applications";

/** Shown on the sign-up form (HTTP 400 body) and, for Google, on /sign-in via `?error=` (S9, S23). */
export const EMAIL_DOMAIN_RESERVED = {
  code: "EMAIL_DOMAIN_RESERVED",
  message: "This email domain is reserved.",
} as const;

/**
 * The internal marker that lets one demo-domain address be created (S23, T10.1). It lives in this
 * process's memory only: `withDemoSignUp` sets it for the async work it runs (createDemoAccount's own
 * sign-up through `auth.handler`), and AsyncLocalStorage hands it only to code started inside that
 * call. Nothing in an HTTP request (headers, cookies, body) can set it, so a client cannot forge it.
 */
const demoSignUp = new AsyncLocalStorage<{ email: string }>();

/** Runs `fn` with permission to create the user `email` (exactly that address) in the demo domain. */
export function withDemoSignUp<T>(email: string, fn: () => Promise<T>): Promise<T> {
  return demoSignUp.run({ email: email.trim().toLowerCase() }, fn);
}

/** Better Auth `user.create.before`: refuses a demo-domain user outside `withDemoSignUp` for that address. */
async function refuseReservedDomain(user: { email?: string | null }): Promise<void> {
  const email = (user.email ?? "").trim().toLowerCase();
  if (!isDemoEmail(email)) return;
  if (demoSignUp.getStore()?.email === email) return;
  throw new APIError("BAD_REQUEST", { ...EMAIL_DOMAIN_RESERVED });
}

export interface AuthConfig {
  db: Db;
  secret: string;
  baseURL: string;
  google: { clientId: string; clientSecret: string };
  /** How verification emails are sent; omitted or null when email delivery is unavailable. */
  emailDelivery?: VerificationDelivery;
  /**
   * Better Auth rate limiting; omitted = its default (on in production only, 100 requests per 10 s,
   * 3 per 10 s on /sign-in and /sign-up). Tests turn it on to prove the demo goes through it.
   */
  rateLimit?: { enabled: boolean };
}

/** Builds the Better Auth instance. Tests pass an isolated database; the app uses `getAuth()`. */
export function createAuth({ db, secret, baseURL, google, emailDelivery = null, rateLimit }: AuthConfig) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret,
    baseURL,
    ...(rateLimit ? { rateLimit } : {}),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Unverified users still sign in; the dashboard shows a banner instead (S17).
      requireEmailVerification: false,
    },
    emailVerification: {
      // Sign-up sends the link (sign-up.mjs:247-260; a failure is logged and sign-up still succeeds).
      // Demo sign-ups go through the same path; the sender returns before sending for them (S23).
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: VERIFICATION_LINK_HOURS * 60 * 60,
      sendVerificationEmail: createSendVerificationEmail(db, emailDelivery),
    },
    // On-demand resends go through the dashboard's Server Action (session address, cooldown); the
    // public endpoint would let anyone trigger a send to any unverified address without a session.
    disabledPaths: ["/send-verification-email"],
    socialProviders: {
      google: { clientId: google.clientId, clientSecret: google.clientSecret },
    },
    account: {
      accountLinking: {
        // Google sign-in never attaches to an existing account with the same email:
        // Better Auth redirects with `?error=account_not_linked` instead.
        disableImplicitLinking: true,
      },
      // Access and refresh tokens are encrypted with the auth secret before storage.
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        // Every user creation goes through createWithHooks (dist/db/with-hooks.mjs:7-23), both
        // email/password sign-up (internalAdapter.createUser, dist/api/routes/sign-up.mjs:223-234,
        // which rethrows our APIError) and OAuth sign-up (dist/oauth2/link-account.mjs:308-340, the
        // callback redirects with its code, dist/api/routes/callback.mjs:152-153). Throwing here
        // happens before the insert, so a refused sign-up writes nothing.
        create: {
          before: async (user) => {
            await refuseReservedDomain(user);
          },
        },
      },
      account: {
        // Better Auth stores the id token as received (encryptOAuthTokens skips it) and
        // the app never reads it after sign-in, so it is not stored at all.
        create: { before: async (account) => ({ data: { ...account, idToken: null } }) },
        update: {
          before: async (account) => ("idToken" in account ? { data: { ...account, idToken: null } } : undefined),
        },
      },
    },
    onAPIError: {
      // OAuth failures land on the sign-in page, which explains the `error` code.
      errorURL: new URL("/sign-in", baseURL).href,
    },
    // nextCookies must stay last so Server Actions can set the session cookie.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthUser = Auth["$Infer"]["Session"]["user"];

let instance: Auth | undefined;

export function getAuth(): Auth {
  if (!instance) {
    const env = getEnv();
    const email = getEmailState();
    const mailer = email.ok ? createResendMailer(email.config) : null;
    instance = createAuth({
      db: getDb(),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      emailDelivery: mailer ? { recipients: mailer.recipients, sender: mailer } : null,
    });
  }
  return instance;
}

/**
 * Verifies the session cookie against the database and returns its user, or null.
 * This is the authoritative check; the proxy only does an optimistic cookie check.
 */
export async function getUserFromHeaders(auth: Auth, headers: Headers): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers });
  return session?.user ?? null;
}
