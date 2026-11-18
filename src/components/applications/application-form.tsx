"use client";

import Link from "next/link";
import { useActionState, useState, useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { APPLICATION_LIMITS, FUTURE_DATE_WARNING, isFutureDate, type ApplicationField } from "@/lib/validation/application";
import { CURRENCIES } from "@/lib/validation/settings";
import type { ApplicationFormAction, ApplicationFormValues } from "./form-state";
import { SourceCombobox } from "./source-combobox";

type FieldConfig = {
  name: ApplicationField;
  label: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
};

const fieldConfigs: FieldConfig[] = [
  { name: "companyName", label: "Company", required: true, maxLength: APPLICATION_LIMITS.companyName },
  { name: "role", label: "Role", required: true, maxLength: APPLICATION_LIMITS.role },
  { name: "url", label: "Job posting URL", type: "url", maxLength: APPLICATION_LIMITS.url, placeholder: "https://" },
];

const sourceField: FieldConfig = { name: "source", label: "Source", maxLength: APPLICATION_LIMITS.source, placeholder: "LinkedIn, Referido…" };

const appliedAtField: FieldConfig = { name: "appliedAt", label: "Applied on", type: "date" };

const salaryField: FieldConfig = { name: "salaryRange", label: "Salary range", maxLength: APPLICATION_LIMITS.salaryRange };

function FieldLabel({ field }: { field: FieldConfig }) {
  return (
    <Label htmlFor={field.name}>
      {field.label}
      {!field.required && <span className="font-normal text-muted-foreground">(optional)</span>}
    </Label>
  );
}

function FieldError({ field, errors }: { field: FieldConfig; errors?: string[] }) {
  if (!errors) return null;
  return (
    <p id={`${field.name}-error`} className="text-sm text-destructive">
      {errors[0]}
    </p>
  );
}

const noSubscribe = () => () => {};

/** False during the server render and hydration, true afterwards (dates depend on the browser's clock and zone). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Applied date with a non-blocking warning when it is after today in the user's zone (S22), or
 * the browser's zone while none is stored. The server still refuses dates beyond any zone's today.
 */
function AppliedAtInput({ value, errors, timeZone }: { value: string; errors?: string[]; timeZone?: string | null }) {
  const field = appliedAtField;
  const [current, setCurrent] = useState(value);
  const hydrated = useHydrated();
  const future = hydrated && isFutureDate(current, timeZone ?? undefined);
  const describedBy = [errors ? `${field.name}-error` : null, future ? `${field.name}-warning` : null, `${field.name}-help`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel field={field} />
      <Input
        id={field.name}
        name={field.name}
        type="date"
        defaultValue={value}
        onChange={(event) => setCurrent(event.currentTarget.value)}
        aria-invalid={errors ? true : undefined}
        aria-describedby={describedBy}
      />
      <FieldError field={field} errors={errors} />
      <p id={`${field.name}-warning`} role="status" className="text-sm text-amber-700 empty:hidden dark:text-amber-400">
        {future ? FUTURE_DATE_WARNING : ""}
      </p>
      <p id={`${field.name}-help`} className="text-sm text-muted-foreground">
        Left empty, it is filled in with the date the application is created in, or moved to, a stage that is not a
        wishlist stage.
      </p>
    </div>
  );
}

function FieldInput({ field, value, errors }: { field: FieldConfig; value: string; errors?: string[] }) {
  const errorId = `${field.name}-error`;
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel field={field} />
      <Input
        id={field.name}
        name={field.name}
        type={field.type ?? "text"}
        required={field.required}
        maxLength={field.maxLength}
        placeholder={field.placeholder}
        // The value comes back with the action state, so a rejected submission keeps the input.
        defaultValue={value}
        list={field.name === "companyName" ? "company-options" : undefined}
        aria-invalid={errors ? true : undefined}
        aria-describedby={errors ? errorId : undefined}
      />
      <FieldError field={field} errors={errors} />
    </div>
  );
}

/** A stage the form offers; `archived` only appears for an application's current stage. */
export type StageOption = { id: string; name: string; archived?: boolean };

export function ApplicationForm({
  action,
  initialValues = {},
  companies,
  sources,
  stages,
  timeZone,
  submitLabel,
}: {
  action: ApplicationFormAction;
  initialValues?: ApplicationFormValues;
  companies: string[];
  /** Suggestions for the source field: the user's sources, then the presets. */
  sources: string[];
  stages: StageOption[];
  /** The user's stored time zone, for the future-date warning; null uses the browser's. */
  timeZone?: string | null;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, { values: initialValues });
  const stageErrors = state.fieldErrors?.stageId;
  const currencyErrors = state.fieldErrors?.salaryCurrency;
  // Preselected: the application's currency, else the user's default (passed in initialValues).
  const currency = state.values.salaryCurrency || initialValues.salaryCurrency || CURRENCIES[0];
  const currencyOptions = (CURRENCIES as readonly string[]).includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4" noValidate>
      {fieldConfigs.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={state.values[field.name] ?? ""}
          errors={state.fieldErrors?.[field.name]}
        />
      ))}
      <div className="flex flex-col gap-2">
        <FieldLabel field={sourceField} />
        <SourceCombobox
          id={sourceField.name}
          name={sourceField.name}
          defaultValue={state.values.source ?? ""}
          suggestions={sources}
          maxLength={sourceField.maxLength}
          placeholder={sourceField.placeholder}
          invalid={Boolean(state.fieldErrors?.source)}
          describedBy={state.fieldErrors?.source ? "source-error" : undefined}
        />
        <FieldError field={sourceField} errors={state.fieldErrors?.source} />
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <FieldInput field={salaryField} value={state.values.salaryRange ?? ""} errors={state.fieldErrors?.salaryRange} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="salaryCurrency">Currency</Label>
          <NativeSelect
            id="salaryCurrency"
            name="salaryCurrency"
            defaultValue={currency}
            aria-invalid={currencyErrors ? true : undefined}
            aria-describedby={currencyErrors ? "salaryCurrency-error" : "salaryCurrency-help"}
          >
            {currencyOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </NativeSelect>
          <p id="salaryCurrency-help" className="sr-only">
            Currency of the salary range; ignored without a salary.
          </p>
          {currencyErrors && (
            <p id="salaryCurrency-error" className="text-sm text-destructive">
              {currencyErrors[0]}
            </p>
          )}
        </div>
      </div>
      <AppliedAtInput value={state.values.appliedAt ?? ""} errors={state.fieldErrors?.appliedAt} timeZone={timeZone} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="stageId">Stage</Label>
        <NativeSelect
          id="stageId"
          name="stageId"
          defaultValue={state.values.stageId ?? stages[0]?.id ?? ""}
          aria-invalid={stageErrors ? true : undefined}
          aria-describedby={stageErrors ? "stageId-error" : undefined}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.archived ? `${stage.name} (archived)` : stage.name}
            </option>
          ))}
        </NativeSelect>
        {stageErrors && (
          <p id="stageId-error" className="text-sm text-destructive">
            {stageErrors[0]}
          </p>
        )}
      </div>
      <datalist id="company-options">
        {companies.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {state.message && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Link href="/dashboard/applications" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
