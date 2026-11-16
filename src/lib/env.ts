import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates raw environment variables. The error names the invalid keys only,
 * never their values, so secrets cannot leak into logs.
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
