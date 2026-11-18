import { z } from "zod";
import { isHttpUrl, optionalText } from "./application";

export const CONTACT_LIMITS = {
  name: 120,
  role: 120,
  email: 254,
  linkedin: 2048,
  notes: 5_000,
} as const;

export const contactInputSchema = z.object({
  name: z
    .string({ error: "Name is required." })
    .trim()
    .min(1, "Name is required.")
    .max(CONTACT_LIMITS.name, `Name must be at most ${CONTACT_LIMITS.name} characters.`),
  role: optionalText(
    z
      .string({ error: "Enter a valid role." })
      .max(CONTACT_LIMITS.role, `Role must be at most ${CONTACT_LIMITS.role} characters.`),
  ),
  email: optionalText(
    z
      .string({ error: "Enter a valid email address." })
      .max(CONTACT_LIMITS.email, `Email must be at most ${CONTACT_LIMITS.email} characters.`)
      .pipe(z.email({ error: "Enter a valid email address." })),
  ),
  linkedin: optionalText(
    z
      .string({ error: "Enter a valid http(s) URL." })
      .max(CONTACT_LIMITS.linkedin, `LinkedIn URL must be at most ${CONTACT_LIMITS.linkedin} characters.`)
      .refine(isHttpUrl, { message: "Enter a valid http(s) URL.", abort: true }),
  ),
  notes: optionalText(
    z
      .string({ error: "Enter valid notes." })
      .max(CONTACT_LIMITS.notes, `Notes must be at most ${CONTACT_LIMITS.notes} characters.`),
  ),
});

export type ContactInput = z.output<typeof contactInputSchema>;
export type ContactField = keyof ContactInput;
export type ContactFieldErrors = Partial<Record<ContactField, string[]>>;

export function parseContactInput(
  input: unknown,
): { success: true; data: ContactInput } | { success: false; fieldErrors: ContactFieldErrors } {
  const result = contactInputSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}
