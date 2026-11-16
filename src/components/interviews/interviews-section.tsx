"use client";

import { useActionState, useState } from "react";
import {
  createInterviewAction,
  deleteInterviewAction,
  setInterviewOutcomeAction,
  updateInterviewAction,
} from "@/app/dashboard/applications/[id]/actions";
import type { DetailFormAction, DetailFormState } from "@/components/applications/form-state";
import {
  LocalDateTime,
  fromLocalInputValue,
  toLocalInputValue,
} from "@/components/applications/local-date-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  INTERVIEW_OLD_DATE_WARNING,
  INTERVIEW_RECORD_OUTCOME_HINT,
  isMoreThanAYearAgo,
  INTERVIEW_NOTES_MAX,
  INTERVIEW_OUTCOMES,
  INTERVIEW_OUTCOME_LABELS,
  INTERVIEW_TYPES,
  INTERVIEW_TYPE_LABELS,
} from "@/lib/validation/interview";
import type { InterviewFormField, InterviewItem } from "./form-state";

/** The form also keeps what the user typed in the local date-time input. */
type Field = InterviewFormField | "scheduledAtLocal";
type State = DetailFormState<Field>;

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  return errors ? (
    <p id={id} className="text-sm text-destructive">
      {errors[0]}
    </p>
  ) : null;
}

function InterviewForm({
  idPrefix,
  action,
  initialValues,
  submitLabel,
  onDone,
}: {
  idPrefix: string;
  action: DetailFormAction<InterviewFormField>;
  initialValues: State["values"];
  submitLabel: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => {
      // The input shows local time; the server stores the instant it means in this browser's zone.
      const local = String(formData.get("scheduledAtLocal") ?? "");
      formData.set("scheduledAt", fromLocalInputValue(local));
      const result = await action(previous, formData);
      if (result.saved) onDone();
      return { ...result, values: { ...result.values, scheduledAtLocal: local } };
    },
    { values: initialValues },
  );
  const id = (field: string) => `${idPrefix}-${field}`;
  const errors = state.fieldErrors ?? {};
  // Non-blocking: an old date is allowed, but it is often a typo in the year.
  const [localDate, setLocalDate] = useState(initialValues.scheduledAtLocal ?? "");
  const oldDate = localDate !== "" && isMoreThanAYearAgo(new Date(localDate));
  const dateDescription = [errors.scheduledAt && id("scheduledAt-error"), oldDate && id("scheduledAt-warning")]
    .filter(Boolean)
    .join(" ");

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={id("scheduledAt")}>Date and time</Label>
          <Input
            id={id("scheduledAt")}
            name="scheduledAtLocal"
            type="datetime-local"
            required
            defaultValue={state.values.scheduledAtLocal ?? ""}
            onChange={(event) => setLocalDate(event.target.value)}
            aria-invalid={errors.scheduledAt ? true : undefined}
            aria-describedby={dateDescription || undefined}
          />
          <FieldError id={id("scheduledAt-error")} errors={errors.scheduledAt} />
          {oldDate && (
            <p id={id("scheduledAt-warning")} className="text-sm text-muted-foreground">
              {INTERVIEW_OLD_DATE_WARNING}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id("type")}>Type</Label>
          <NativeSelect
            id={id("type")}
            name="type"
            defaultValue={state.values.type ?? "video"}
            aria-invalid={errors.type ? true : undefined}
            aria-describedby={errors.type ? id("type-error") : undefined}
          >
            {INTERVIEW_TYPES.map((type) => (
              <option key={type} value={type}>
                {INTERVIEW_TYPE_LABELS[type]}
              </option>
            ))}
          </NativeSelect>
          <FieldError id={id("type-error")} errors={errors.type} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id("outcome")}>Outcome</Label>
          <NativeSelect
            id={id("outcome")}
            name="outcome"
            defaultValue={state.values.outcome ?? "pending"}
            aria-invalid={errors.outcome ? true : undefined}
            aria-describedby={errors.outcome ? id("outcome-error") : undefined}
          >
            {INTERVIEW_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {INTERVIEW_OUTCOME_LABELS[outcome]}
              </option>
            ))}
          </NativeSelect>
          <FieldError id={id("outcome-error")} errors={errors.outcome} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("notes")}>
          Notes <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={id("notes")}
          name="notes"
          maxLength={INTERVIEW_NOTES_MAX}
          defaultValue={state.values.notes ?? ""}
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? id("notes-error") : undefined}
        />
        <FieldError id={id("notes-error")} errors={errors.notes} />
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

function InterviewRow({ applicationId, interview }: { applicationId: string; interview: InterviewItem }) {
  const [editing, setEditing] = useState(false);
  const [outcomeState, outcomeAction, outcomePending] = useActionState(
    setInterviewOutcomeAction.bind(null, applicationId, interview.id),
    {},
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteInterviewAction.bind(null, applicationId, interview.id),
    {},
  );
  const typeLabel = INTERVIEW_TYPE_LABELS[interview.type];
  const name = `${typeLabel} interview`;
  const outcomeId = `interview-${interview.id}-outcome`;

  if (editing) {
    return (
      <li className="rounded-lg p-3 ring-1 ring-foreground/10">
        <InterviewForm
          idPrefix={`interview-${interview.id}`}
          action={updateInterviewAction.bind(null, applicationId, interview.id)}
          initialValues={{
            scheduledAtLocal: toLocalInputValue(interview.scheduledAt),
            type: interview.type,
            outcome: interview.outcome,
            notes: interview.notes ?? "",
          }}
          submitLabel="Save interview"
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {typeLabel} · <LocalDateTime value={interview.scheduledAt} />
        </p>
        <span className="text-sm text-muted-foreground">{INTERVIEW_OUTCOME_LABELS[interview.outcome]}</span>
      </div>
      {interview.needsOutcome && <p className="text-sm text-destructive">{INTERVIEW_RECORD_OUTCOME_HINT}</p>}
      {interview.notes && <p className="text-sm whitespace-pre-wrap">{interview.notes}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <form action={outcomeAction} className="flex items-center gap-2">
          <label htmlFor={outcomeId} className="sr-only">
            Outcome of the {name}
          </label>
          <NativeSelect id={outcomeId} name="outcome" defaultValue={interview.outcome} className="w-32">
            {INTERVIEW_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {INTERVIEW_OUTCOME_LABELS[outcome]}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" variant="outline" disabled={outcomePending} aria-label={`Set outcome of the ${name}`}>
            Set outcome
          </Button>
        </form>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)} aria-label={`Edit the ${name}`}>
          Edit
        </Button>
        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(`Delete this ${name}?`)) event.preventDefault();
          }}
        >
          <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete the ${name}`}>
            Delete
          </Button>
        </form>
      </div>
      {(outcomeState.message ?? deleteState.message) && (
        <p role="alert" className="text-sm text-destructive">
          {outcomeState.message ?? deleteState.message}
        </p>
      )}
    </li>
  );
}

/** Interviews of one application, soonest first, with add, edit, outcome and delete. */
export function InterviewsSection({ applicationId, interviews }: { applicationId: string; interviews: InterviewItem[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <section aria-labelledby="interviews-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="interviews-heading" className="text-lg font-semibold">
          Interviews
        </h2>
        {!adding && (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            Add interview
          </Button>
        )}
      </div>
      {adding && (
        <div className="rounded-lg p-3 ring-1 ring-foreground/10">
          <InterviewForm
            idPrefix="new-interview"
            action={createInterviewAction.bind(null, applicationId)}
            initialValues={{}}
            submitLabel="Add interview"
            onDone={() => setAdding(false)}
          />
        </div>
      )}
      {interviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">No interviews yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {interviews.map((interview) => (
            <InterviewRow key={interview.id} applicationId={applicationId} interview={interview} />
          ))}
        </ul>
      )}
    </section>
  );
}
