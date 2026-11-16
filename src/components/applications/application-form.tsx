"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APPLICATION_LIMITS, type ApplicationField } from "@/lib/validation/application";
import type { ApplicationFormAction, ApplicationFormValues } from "./form-state";

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
  { name: "source", label: "Source", maxLength: APPLICATION_LIMITS.source, placeholder: "LinkedIn, referral…" },
  { name: "salaryRange", label: "Salary range", maxLength: APPLICATION_LIMITS.salaryRange },
  { name: "appliedAt", label: "Applied on", type: "date" },
];

export function ApplicationForm({
  action,
  initialValues = {},
  companies,
  submitLabel,
}: {
  action: ApplicationFormAction;
  initialValues?: ApplicationFormValues;
  companies: string[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, { values: initialValues });

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4" noValidate>
      {fieldConfigs.map((field) => {
        const errors = state.fieldErrors?.[field.name];
        const errorId = `${field.name}-error`;
        return (
          <div key={field.name} className="flex flex-col gap-2">
            <Label htmlFor={field.name}>
              {field.label}
              {!field.required && <span className="font-normal text-muted-foreground">(optional)</span>}
            </Label>
            <Input
              id={field.name}
              name={field.name}
              type={field.type ?? "text"}
              required={field.required}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              // The value comes back with the action state, so a rejected submission keeps the input.
              defaultValue={state.values[field.name] ?? ""}
              list={field.name === "companyName" ? "company-options" : undefined}
              aria-invalid={errors ? true : undefined}
              aria-describedby={errors ? errorId : undefined}
            />
            {errors && (
              <p id={errorId} className="text-sm text-destructive">
                {errors[0]}
              </p>
            )}
          </div>
        );
      })}
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
