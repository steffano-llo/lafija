import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth, getUserFromHeaders, type AuthUser } from "@/lib/auth";

/** Verified current user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  // Read the request first: it marks the route dynamic, so the build never resolves auth secrets.
  const requestHeaders = await headers();
  return getUserFromHeaders(getAuth(), requestHeaders);
});

/**
 * Data access entry point: every query on user data must start here and filter by
 * the returned user's id. Redirects to sign-in when the session is missing or invalid.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }
  return user;
}
