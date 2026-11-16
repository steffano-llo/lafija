import type { ContactField } from "@/lib/validation/contact";

export const CONTACT_FIELDS = ["name", "role", "email", "linkedin", "notes"] as const satisfies readonly ContactField[];

export type ContactFormField = (typeof CONTACT_FIELDS)[number];

/** A contact as the detail page passes it to the browser. */
export type ContactItem = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  linkedin: string | null;
  notes: string | null;
};
