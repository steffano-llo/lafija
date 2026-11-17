/**
 * Demo accounts (S6, S23). Every demo user has an address `demo-<random>@demo.lafija.invalid`
 * (`.invalid` is reserved by RFC 2606, so it can never be a deliverable address) and a
 * `demo_account` row; the database refuses that row for any other address.
 */
export const DEMO_EMAIL_DOMAIN = "demo.lafija.invalid";

/** SQL LIKE pattern for demo addresses (lower case: the database checks it case-sensitively). */
export const DEMO_EMAIL_LIKE = `%@${DEMO_EMAIL_DOMAIN}`;

/** A demo account and everything in it is deleted this long after it was created. */
export const DEMO_LIFETIME_HOURS = 24;

/** Live (unexpired) demo accounts at most; "Try the demo" is refused above it. */
export const DEMO_ACCOUNT_LIMIT = 200;

/** Whether an address has the demo domain (any case). */
export function isDemoEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}
