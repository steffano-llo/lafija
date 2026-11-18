"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { createDemoAccount, demoErrorMessage } from "@/server/demo";

export type DemoActionState = { error: string } | null;

/**
 * "Try the demo" (S6): creates a seeded demo account (`createDemoAccount`: live-demo cap, Better Auth
 * rate limiting, no email), signs the visitor in with `auth.api.signInEmail` (the nextCookies plugin
 * sets the session cookie from this Server Action) and opens the board. Refusals come back as an
 * English message.
 */
export async function startDemoAction(): Promise<DemoActionState> {
  const requestHeaders = await headers();
  const auth = getAuth();
  const result = await createDemoAccount(auth, getDb(), {
    baseURL: getEnv().BETTER_AUTH_URL,
    clientIp: requestHeaders.get("x-forwarded-for"),
  });
  if (!result.ok) return { error: demoErrorMessage(result.reason) };
  try {
    await auth.api.signInEmail({ body: { email: result.email, password: result.password }, headers: requestHeaders });
  } catch {
    return { error: demoErrorMessage("failed") };
  }
  redirect("/dashboard/board");
}
