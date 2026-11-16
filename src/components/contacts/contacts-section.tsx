"use client";

import { useActionState, useState } from "react";
import {
  createContactAction,
  deleteContactAction,
  linkContactAction,
  unlinkContactAction,
  updateContactAction,
} from "@/app/dashboard/applications/[id]/actions";
import type { DetailFormAction, DetailFormState } from "@/components/applications/form-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CONTACT_LIMITS } from "@/lib/validation/contact";
import type { ContactFormField, ContactItem } from "./form-state";

type State = DetailFormState<ContactFormField>;

const inputFields: { name: Exclude<ContactFormField, "notes">; label: string; type?: string; required?: boolean; placeholder?: string }[] = [
  { name: "name", label: "Name", required: true },
  { name: "role", label: "Role" },
  { name: "email", label: "Email", type: "email" },
  { name: "linkedin", label: "LinkedIn URL", type: "url", placeholder: "https://www.linkedin.com/in/…" },
];

function ContactForm({
  idPrefix,
  action,
  initialValues,
  submitLabel,
  onDone,
}: {
  idPrefix: string;
  action: DetailFormAction<ContactFormField>;
  initialValues: State["values"];
  submitLabel: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => {
      const result = await action(previous, formData);
      if (result.saved) onDone();
      return result;
    },
    { values: initialValues },
  );
  const id = (field: string) => `${idPrefix}-${field}`;
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        {inputFields.map((field) => (
          <div key={field.name} className="flex flex-col gap-2">
            <Label htmlFor={id(field.name)}>
              {field.label}
              {!field.required && <span className="font-normal text-muted-foreground">(optional)</span>}
            </Label>
            <Input
              id={id(field.name)}
              name={field.name}
              type={field.type ?? "text"}
              required={field.required}
              maxLength={CONTACT_LIMITS[field.name]}
              placeholder={field.placeholder}
              defaultValue={state.values[field.name] ?? ""}
              aria-invalid={errors[field.name] ? true : undefined}
              aria-describedby={errors[field.name] ? id(`${field.name}-error`) : undefined}
            />
            {errors[field.name] && (
              <p id={id(`${field.name}-error`)} className="text-sm text-destructive">
                {errors[field.name]![0]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("notes")}>
          Notes <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={id("notes")}
          name="notes"
          maxLength={CONTACT_LIMITS.notes}
          defaultValue={state.values.notes ?? ""}
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? id("notes-error") : undefined}
        />
        {errors.notes && (
          <p id={id("notes-error")} className="text-sm text-destructive">
            {errors.notes[0]}
          </p>
        )}
      </div>
      {state.message && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ContactRow({ applicationId, contact }: { applicationId: string; contact: ContactItem }) {
  const [editing, setEditing] = useState(false);
  const [unlinkState, unlinkAction, unlinkPending] = useActionState(
    unlinkContactAction.bind(null, applicationId, contact.id),
    {},
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteContactAction.bind(null, applicationId, contact.id),
    {},
  );

  if (editing) {
    return (
      <li className="rounded-lg p-3 ring-1 ring-foreground/10">
        <ContactForm
          idPrefix={`contact-${contact.id}`}
          action={updateContactAction.bind(null, applicationId, contact.id)}
          initialValues={{
            name: contact.name,
            role: contact.role ?? "",
            email: contact.email ?? "",
            linkedin: contact.linkedin ?? "",
            notes: contact.notes ?? "",
          }}
          submitLabel="Save contact"
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  const message = unlinkState.message ?? deleteState.message;
  return (
    <li className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">
          {contact.name}
          {contact.role && <span className="font-normal text-muted-foreground"> · {contact.role}</span>}
        </p>
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="text-sm underline-offset-4 hover:underline">
            {contact.email}
          </a>
        )}
        {contact.linkedin && (
          <a
            href={contact.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline-offset-4 hover:underline"
          >
            LinkedIn profile
          </a>
        )}
        {contact.notes && <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)} aria-label={`Edit ${contact.name}`}>
          Edit
        </Button>
        <form action={unlinkAction}>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={unlinkPending}
            aria-label={`Unlink ${contact.name} from this application`}
          >
            Unlink
          </Button>
        </form>
        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(`Delete ${contact.name}? They will be removed from every application.`)) {
              event.preventDefault();
            }
          }}
        >
          <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete ${contact.name}`}>
            Delete
          </Button>
        </form>
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </li>
  );
}

function LinkContactForm({ applicationId, linkable }: { applicationId: string; linkable: ContactItem[] }) {
  const [state, formAction, pending] = useActionState(linkContactAction.bind(null, applicationId), {});
  if (linkable.length === 0) return null;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="link-contact">Link an existing contact</Label>
          <NativeSelect id="link-contact" name="contactId" className="w-64">
            {linkable.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.role ? `${contact.name} (${contact.role})` : contact.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Link
        </Button>
      </div>
      {state.message && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Contacts linked to one application; others of the same company can be linked. */
export function ContactsSection({
  applicationId,
  companyName,
  contacts,
  linkable,
}: {
  applicationId: string;
  companyName: string;
  contacts: ContactItem[];
  linkable: ContactItem[];
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section aria-labelledby="contacts-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="contacts-heading" className="text-lg font-semibold">
          Contacts
        </h2>
        {!adding && (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            New contact
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Contacts belong to {companyName} and can be linked to any of its applications.
      </p>
      {adding && (
        <div className="rounded-lg p-3 ring-1 ring-foreground/10">
          <ContactForm
            idPrefix="new-contact"
            action={createContactAction.bind(null, applicationId)}
            initialValues={{}}
            submitLabel="Add contact"
            onDone={() => setAdding(false)}
          />
        </div>
      )}
      <LinkContactForm applicationId={applicationId} linkable={linkable} />
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts linked yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((contact) => (
            <ContactRow key={contact.id} applicationId={applicationId} contact={contact} />
          ))}
        </ul>
      )}
    </section>
  );
}
