type AuthResult = { error: { message?: string } | null };

const SIGN_IN_ERRORS: Record<string, string> = {
  // Better Auth refuses Google sign-in for an email that already has an account,
  // because implicit account linking is disabled (src/lib/auth.ts).
  account_not_linked: "An account with this email already exists. Sign in with your email and password.",
};

/** English message for the `?error=` code Better Auth adds when it redirects to /sign-in. */
export function signInErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  return SIGN_IN_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

/**
 * Runs an auth client call and returns the message to show, or null on success.
 * A thrown call (network failure, aborted request) reports `fallback` instead of escaping.
 */
export async function runAuthRequest(request: () => Promise<AuthResult>, fallback: string): Promise<string | null> {
  try {
    const { error } = await request();
    return error ? (error.message ?? fallback) : null;
  } catch {
    return fallback;
  }
}

/** Signs out and only then leaves; returns the message to show when sign-out failed. */
export async function signOutAndLeave(signOut: () => Promise<AuthResult>, leave: () => void): Promise<string | null> {
  const error = await runAuthRequest(async () => {
    const { error } = await signOut();
    // A failed sign-out always shows the same copy, never the raw server message.
    return { error: error ? {} : null };
  }, "Could not sign out. Please try again.");
  if (!error) leave();
  return error;
}
