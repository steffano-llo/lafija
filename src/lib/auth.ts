import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import * as schema from "@/db/schema";
import { getDb } from "@/db";
import { getEnv } from "@/lib/env";

type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export interface AuthConfig {
  db: AuthDatabase;
  secret: string;
  baseURL: string;
  google: { clientId: string; clientSecret: string };
}

/** Builds the Better Auth instance. Tests pass an isolated database; the app uses `getAuth()`. */
export function createAuth({ db, secret, baseURL, google }: AuthConfig) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
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
    instance = createAuth({
      db: getDb(),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
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
