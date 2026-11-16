import "server-only";

import { and, asc, eq, notExists, sql } from "drizzle-orm";
import { application, applicationContact, contact } from "@/db/schema";
import { parseContactInput, type ContactFieldErrors } from "@/lib/validation/contact";
import type { Db } from "./applications";
import { rowsOf } from "./board";
import { isId } from "./ids";

export type Contact = {
  id: string;
  companyId: string;
  name: string;
  role: string | null;
  email: string | null;
  linkedin: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactResult =
  | { ok: true; contact: Contact }
  | { ok: false; reason: "invalid"; fieldErrors: ContactFieldErrors }
  | { ok: false; reason: "not_found" };

export type LinkContactResult = { ok: true } | { ok: false; reason: "not_found" | "other_company" };

const notFound = { ok: false, reason: "not_found" } as const;

const contactColumns = {
  id: contact.id,
  companyId: contact.companyId,
  name: contact.name,
  role: contact.role,
  email: contact.email,
  linkedin: contact.linkedin,
  notes: contact.notes,
  createdAt: contact.createdAt,
  updatedAt: contact.updatedAt,
};

const byName = [asc(sql`lower(${contact.name})`), asc(contact.createdAt), asc(contact.id)];

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

/** Company of the user's application, or null when the application is unknown or someone else's. */
async function applicationCompany(db: Db, userId: string, applicationId: string): Promise<string | null> {
  if (!isId(applicationId)) return null;
  const [row] = await db
    .select({ companyId: application.companyId })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.id, applicationId)))
    .limit(1);
  return row?.companyId ?? null;
}

async function getContact(db: Db, userId: string, id: string): Promise<Contact | null> {
  if (!isId(id)) return null;
  const [row] = await db
    .select(contactColumns)
    .from(contact)
    .where(and(eq(contact.userId, userId), eq(contact.id, id)))
    .limit(1);
  return row ?? null;
}

/** Contacts linked to the user's application, by name; null when the application is not theirs. */
export async function listApplicationContacts(
  db: Db,
  userId: string,
  applicationId: string,
): Promise<Contact[] | null> {
  if ((await applicationCompany(db, userId, applicationId)) === null) return null;
  return db
    .select(contactColumns)
    .from(applicationContact)
    .innerJoin(contact, eq(contact.id, applicationContact.contactId))
    .where(and(eq(applicationContact.userId, userId), eq(applicationContact.applicationId, applicationId)))
    .orderBy(...byName);
}

/**
 * Contacts the user can link to this application: those of its company not linked yet, by name.
 * Null when the application is not theirs.
 */
export async function listLinkableContacts(
  db: Db,
  userId: string,
  applicationId: string,
): Promise<Contact[] | null> {
  const companyId = await applicationCompany(db, userId, applicationId);
  if (companyId === null) return null;
  return db
    .select(contactColumns)
    .from(contact)
    .where(
      and(
        eq(contact.userId, userId),
        eq(contact.companyId, companyId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(applicationContact)
            .where(
              and(
                eq(applicationContact.contactId, contact.id),
                eq(applicationContact.applicationId, applicationId),
              ),
            ),
        ),
      ),
    )
    .orderBy(...byName);
}

/**
 * Creates a contact in the company of the user's application and links it to that application.
 * Contact and link are one statement, so there is never a contact without the link it was made for.
 */
export async function createContact(
  db: Db,
  userId: string,
  applicationId: string,
  input: unknown,
): Promise<ContactResult> {
  if (!isId(applicationId)) return notFound;
  const parsed = parseContactInput(input);
  if (!parsed.success) {
    return (await applicationCompany(db, userId, applicationId)) !== null
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const { name, role, email, linkedin, notes } = parsed.data;
  const id = crypto.randomUUID();
  const result = await db.execute(sql`
    with "app" as (
      select a."id", a."company_id", a."user_id" from "application" a
      where a."id" = ${applicationId} and a."user_id" = ${userId}
    ),
    "created" as (
      insert into "contact" ("id", "user_id", "company_id", "name", "role", "email", "linkedin", "notes")
      select ${id}, a."user_id", a."company_id", ${name}, ${role}, ${email}, ${linkedin}, ${notes} from "app" a
      returning "id", "company_id", "user_id"
    ),
    "linked" as (
      insert into "application_contact" ("application_id", "contact_id", "user_id", "company_id")
      select ${applicationId}, c."id", c."user_id", c."company_id" from "created" c
      returning "contact_id"
    )
    select "id" from "created"
  `);
  if (rowsOf<{ id: string }>(result).length === 0) return notFound;
  const created = await getContact(db, userId, id);
  return created ? { ok: true, contact: created } : notFound;
}

/** Replaces the fields of the user's contact; its company never changes. */
export async function updateContact(db: Db, userId: string, id: string, input: unknown): Promise<ContactResult> {
  if (!isId(id)) return notFound;
  const parsed = parseContactInput(input);
  if (!parsed.success) {
    return (await getContact(db, userId, id))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const [row] = await db
    .update(contact)
    .set(parsed.data)
    .where(and(eq(contact.userId, userId), eq(contact.id, id)))
    .returning(contactColumns);
  return row ? { ok: true, contact: row } : notFound;
}

/** Deletes the user's contact; its links to applications go with it (cascade). */
export async function deleteContact(db: Db, userId: string, id: string): Promise<{ ok: true } | typeof notFound> {
  if (!isId(id)) return notFound;
  const deleted = await db
    .delete(contact)
    .where(and(eq(contact.userId, userId), eq(contact.id, id)))
    .returning({ id: contact.id });
  return deleted.length > 0 ? { ok: true } : notFound;
}

/**
 * Links the user's contact to the user's application. The insert only selects the pair when both
 * belong to the user and to the same company; linking twice is a no-op. The foreign keys enforce
 * the same rule in the database.
 */
export async function linkContact(
  db: Db,
  userId: string,
  applicationId: string,
  contactId: string,
): Promise<LinkContactResult> {
  if (!isId(applicationId) || !isId(contactId)) return notFound;
  const result = await db.execute(sql`
    insert into "application_contact" ("application_id", "contact_id", "user_id", "company_id")
    select a."id", c."id", a."user_id", a."company_id"
    from "application" a
    join "contact" c on c."company_id" = a."company_id" and c."user_id" = a."user_id"
    where a."id" = ${applicationId} and a."user_id" = ${userId} and c."id" = ${contactId}
    on conflict do nothing
    returning "contact_id"
  `);
  if (rowsOf<{ contact_id: string }>(result).length > 0) return { ok: true };

  // Nothing inserted: already linked, someone else's or unknown id, or another company.
  const companyId = await applicationCompany(db, userId, applicationId);
  const target = await getContact(db, userId, contactId);
  if (companyId === null || !target) return notFound;
  return target.companyId === companyId ? { ok: true } : { ok: false, reason: "other_company" };
}

/** Removes the link between the user's application and contact; the contact stays. Idempotent. */
export async function unlinkContact(
  db: Db,
  userId: string,
  applicationId: string,
  contactId: string,
): Promise<{ ok: true } | typeof notFound> {
  if (!isId(applicationId) || !isId(contactId)) return notFound;
  const deleted = await db
    .delete(applicationContact)
    .where(
      and(
        eq(applicationContact.userId, userId),
        eq(applicationContact.applicationId, applicationId),
        eq(applicationContact.contactId, contactId),
      ),
    )
    .returning({ contactId: applicationContact.contactId });
  if (deleted.length > 0) return { ok: true };
  const owned = (await applicationCompany(db, userId, applicationId)) !== null && (await getContact(db, userId, contactId));
  return owned ? { ok: true } : notFound;
}
