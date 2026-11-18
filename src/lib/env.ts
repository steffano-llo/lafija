import { z } from "zod";

/** Who may receive reminder emails: everyone (`*`, needs a verified sending domain) or a list. */
export type RecipientAllowlist = { everyone: boolean; addresses: string[] };

const isEmail = (value: string) => z.email().safeParse(value).success;

/**
 * Parses `EMAIL_ALLOWED_RECIPIENTS`: comma-separated addresses and/or `*`, compared ignoring case.
 * Unset or blank means nobody gets email. Returns null when an entry is neither `*` nor an address.
 */
export function parseRecipientAllowlist(raw: string | undefined): RecipientAllowlist | null {
  const allowlist: RecipientAllowlist = { everyone: false, addresses: [] };
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim().toLowerCase();
    if (value === "") continue;
    if (value === "*") allowlist.everyone = true;
    else if (!isEmail(value)) return null;
    else if (!allowlist.addresses.includes(value)) allowlist.addresses.push(value);
  }
  return allowlist;
}

/** `name@domain` or `Display Name <name@domain>`, the two forms Resend accepts for `from`. */
function isFromAddress(value: string): boolean {
  const named = /^[^<>]*<([^<>]+)>$/.exec(value.trim());
  return isEmail(named ? named[1] : value.trim());
}

/** Optional variable: unset and empty (e.g. `RESEND_API_KEY=`) both mean "not configured". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

/**
 * Email variables (T8), all optional and parsed apart from the rest (S18): without them, or with a
 * malformed one, the app works normally and only email is off.
 */
const emailSchema = z.object({
  QSTASH_CURRENT_SIGNING_KEY: optional(z.string().regex(/^\S+$/)),
  QSTASH_NEXT_SIGNING_KEY: optional(z.string().regex(/^\S+$/)),
  RESEND_API_KEY: optional(z.string().regex(/^re_\S+$/)),
  EMAIL_FROM: optional(z.string().refine(isFromAddress)),
  EMAIL_ALLOWED_RECIPIENTS: optional(z.string().refine((value) => parseRecipientAllowlist(value) !== null)),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the required environment variables (email variables are ignored here, see
 * `parseEmailEnv`). The error names the invalid keys only, never their values, so secrets cannot
 * leak into logs.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${keys.join(", ")}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Lazily validated process environment, so importing this module never throws at build time. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Everything the reminder email job, its endpoint and verification emails need. */
export type EmailConfig = {
  currentSigningKey: string;
  nextSigningKey: string;
  resendApiKey: string;
  from: string;
  recipients: RecipientAllowlist;
  /** Public origin of the app (BETTER_AUTH_URL without a trailing slash), used in email links. */
  appUrl: string;
  /** The URL QStash posts to; its signature's subject must equal it. */
  cronUrl: string;
};

/**
 * Whether email can be sent. `not_configured` names the missing delivery variables;
 * `misconfigured` names the malformed ones (S18). Never a value.
 */
export type EmailState =
  | { ok: true; config: EmailConfig }
  | { ok: false; reason: "not_configured"; missing: string[] }
  | { ok: false; reason: "misconfigured"; keys: string[] };

export const CRON_REMINDERS_PATH = "/api/cron/reminders";

const REQUIRED_EMAIL_KEYS = ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "RESEND_API_KEY", "EMAIL_FROM"] as const;

/**
 * Email is configured when the two QStash signing keys, the Resend key and the sender are set and
 * every email variable is well formed. A malformed one wins over missing ones. The allowlist is
 * optional: unset = nobody. `appUrl` is BETTER_AUTH_URL.
 */
export function parseEmailEnv(raw: Record<string, string | undefined>, appUrl: string): EmailState {
  const result = emailSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    return { ok: false, reason: "misconfigured", keys };
  }
  const env = result.data;
  const missing = REQUIRED_EMAIL_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) return { ok: false, reason: "not_configured", missing };
  const origin = appUrl.replace(/\/+$/, "");
  return {
    ok: true,
    config: {
      currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY!,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY!,
      resendApiKey: env.RESEND_API_KEY!,
      from: env.EMAIL_FROM!,
      recipients: parseRecipientAllowlist(env.EMAIL_ALLOWED_RECIPIENTS) ?? { everyone: false, addresses: [] },
      appUrl: origin,
      cronUrl: `${origin}${CRON_REMINDERS_PATH}`,
    },
  };
}

export const CRON_CLEANUP_PATH = "/api/cron/cleanup";

/** What the demo cleanup endpoint needs to verify QStash: the two signing keys and its own URL. */
export type QStashConfig = { currentSigningKey: string; nextSigningKey: string; cleanupUrl: string };

const signingKey = z.string().regex(/^\S+$/);

/**
 * The QStash signing keys for the demo cleanup (T10), parsed apart from the email group: the
 * cleanup runs without Resend, a sender or an allowlist, and a malformed email variable does not
 * stop it. Null when either key is missing, empty or malformed.
 */
export function parseQStashEnv(raw: Record<string, string | undefined>, appUrl: string): QStashConfig | null {
  const current = signingKey.safeParse(raw.QSTASH_CURRENT_SIGNING_KEY);
  const next = signingKey.safeParse(raw.QSTASH_NEXT_SIGNING_KEY);
  if (!current.success || !next.success) return null;
  return {
    currentSigningKey: current.data,
    nextSigningKey: next.data,
    cleanupUrl: `${appUrl.replace(/\/+$/, "")}${CRON_CLEANUP_PATH}`,
  };
}

let emailCached: EmailState | undefined;

/**
 * The process's email state, parsed once. A malformed email variable is logged once with
 * `console.warn`, naming the keys only; the rest of the app keeps working.
 */
export function getEmailState(): EmailState {
  if (!emailCached) {
    emailCached = parseEmailEnv(process.env, getEnv().BETTER_AUTH_URL);
    if (!emailCached.ok && emailCached.reason === "misconfigured") {
      console.warn(`Email delivery is disabled: invalid environment variables: ${emailCached.keys.join(", ")}`);
    }
  }
  return emailCached;
}
