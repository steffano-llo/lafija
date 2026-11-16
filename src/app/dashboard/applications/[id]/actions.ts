"use server";

import { revalidatePath } from "next/cache";
import {
  DETAIL_MESSAGES,
  readFields,
  type DetailButtonState,
  type DetailFormState,
} from "@/components/applications/form-state";
import { CONTACT_FIELDS, type ContactFormField } from "@/components/contacts/form-state";
import { INTERVIEW_FIELDS, type InterviewFormField } from "@/components/interviews/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { updateApplicationNotes } from "@/server/applications";
import { createContact, deleteContact, linkContact, unlinkContact, updateContact } from "@/server/contacts";
import { isId } from "@/server/ids";
import { createInterview, deleteInterview, setInterviewOutcome, updateInterview } from "@/server/interviews";

// Every action: `requireUser()` first, bound ids re-checked at runtime (the client can post any
// value), then a data function that filters by the user. Unknown and foreign ids change nothing.

function revalidateDetail(applicationId: string) {
  revalidatePath(`/dashboard/applications/${applicationId}`);
}

export async function updateNotesAction(
  applicationId: unknown,
  _state: DetailFormState<"notes">,
  formData: FormData,
): Promise<DetailFormState<"notes">> {
  const user = await requireUser();
  const values = readFields(formData, ["notes"] as const);
  if (!isId(applicationId)) return { values, message: DETAIL_MESSAGES.application_not_found };
  const result = await updateApplicationNotes(getDb(), user.id, applicationId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: DETAIL_MESSAGES.invalid }
      : { values, message: DETAIL_MESSAGES.application_not_found };
  }
  revalidateDetail(applicationId);
  return { values: { notes: result.notes ?? "" }, saved: true };
}

export async function createInterviewAction(
  applicationId: unknown,
  _state: DetailFormState<InterviewFormField>,
  formData: FormData,
): Promise<DetailFormState<InterviewFormField>> {
  const user = await requireUser();
  const values = readFields(formData, INTERVIEW_FIELDS);
  if (!isId(applicationId)) return { values, message: DETAIL_MESSAGES.application_not_found };
  const result = await createInterview(getDb(), user.id, applicationId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: DETAIL_MESSAGES.invalid }
      : { values, message: DETAIL_MESSAGES.application_not_found };
  }
  revalidateDetail(applicationId);
  return { values: {}, saved: true };
}

export async function updateInterviewAction(
  applicationId: unknown,
  interviewId: unknown,
  _state: DetailFormState<InterviewFormField>,
  formData: FormData,
): Promise<DetailFormState<InterviewFormField>> {
  const user = await requireUser();
  const values = readFields(formData, INTERVIEW_FIELDS);
  if (!isId(applicationId) || !isId(interviewId)) return { values, message: DETAIL_MESSAGES.interview_not_found };
  const result = await updateInterview(getDb(), user.id, interviewId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: DETAIL_MESSAGES.invalid }
      : { values, message: DETAIL_MESSAGES.interview_not_found };
  }
  revalidateDetail(applicationId);
  return { values, saved: true };
}

export async function setInterviewOutcomeAction(
  applicationId: unknown,
  interviewId: unknown,
  _state: DetailButtonState,
  formData: FormData,
): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(applicationId) || !isId(interviewId)) return { message: DETAIL_MESSAGES.interview_not_found };
  const result = await setInterviewOutcome(getDb(), user.id, interviewId, formData.get("outcome"));
  if (!result.ok) {
    return {
      message: result.reason === "invalid" ? DETAIL_MESSAGES.invalid_outcome : DETAIL_MESSAGES.interview_not_found,
    };
  }
  revalidateDetail(applicationId);
  return {};
}

export async function deleteInterviewAction(applicationId: unknown, interviewId: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(applicationId) || !isId(interviewId)) return { message: DETAIL_MESSAGES.interview_not_found };
  const result = await deleteInterview(getDb(), user.id, interviewId);
  if (!result.ok) return { message: DETAIL_MESSAGES.interview_not_found };
  revalidateDetail(applicationId);
  return {};
}

export async function createContactAction(
  applicationId: unknown,
  _state: DetailFormState<ContactFormField>,
  formData: FormData,
): Promise<DetailFormState<ContactFormField>> {
  const user = await requireUser();
  const values = readFields(formData, CONTACT_FIELDS);
  if (!isId(applicationId)) return { values, message: DETAIL_MESSAGES.application_not_found };
  const result = await createContact(getDb(), user.id, applicationId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: DETAIL_MESSAGES.invalid }
      : { values, message: DETAIL_MESSAGES.application_not_found };
  }
  revalidateDetail(applicationId);
  return { values: {}, saved: true };
}

export async function updateContactAction(
  applicationId: unknown,
  contactId: unknown,
  _state: DetailFormState<ContactFormField>,
  formData: FormData,
): Promise<DetailFormState<ContactFormField>> {
  const user = await requireUser();
  const values = readFields(formData, CONTACT_FIELDS);
  if (!isId(applicationId) || !isId(contactId)) return { values, message: DETAIL_MESSAGES.contact_not_found };
  const result = await updateContact(getDb(), user.id, contactId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: DETAIL_MESSAGES.invalid }
      : { values, message: DETAIL_MESSAGES.contact_not_found };
  }
  // The contact may be linked to other applications too.
  revalidatePath("/dashboard/applications", "layout");
  return { values, saved: true };
}

/** Links the contact chosen in the form's `contactId` select. */
export async function linkContactAction(
  applicationId: unknown,
  _state: DetailButtonState,
  formData: FormData,
): Promise<DetailButtonState> {
  const user = await requireUser();
  const contactId = formData.get("contactId");
  if (!isId(applicationId) || !isId(contactId)) return { message: DETAIL_MESSAGES.contact_not_found };
  const result = await linkContact(getDb(), user.id, applicationId, contactId);
  if (!result.ok) {
    return { message: result.reason === "other_company" ? DETAIL_MESSAGES.other_company : DETAIL_MESSAGES.contact_not_found };
  }
  revalidateDetail(applicationId);
  return {};
}

export async function unlinkContactAction(applicationId: unknown, contactId: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(applicationId) || !isId(contactId)) return { message: DETAIL_MESSAGES.contact_not_found };
  const result = await unlinkContact(getDb(), user.id, applicationId, contactId);
  if (!result.ok) return { message: DETAIL_MESSAGES.contact_not_found };
  revalidateDetail(applicationId);
  return {};
}

export async function deleteContactAction(applicationId: unknown, contactId: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(applicationId) || !isId(contactId)) return { message: DETAIL_MESSAGES.contact_not_found };
  const result = await deleteContact(getDb(), user.id, contactId);
  if (!result.ok) return { message: DETAIL_MESSAGES.contact_not_found };
  // Its links to other applications are gone too.
  revalidatePath("/dashboard/applications", "layout");
  return {};
}
