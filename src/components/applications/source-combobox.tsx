"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Input } from "@/components/ui/input";

/**
 * Source field (S20): a free-text combobox suggesting the user's sources, then the presets. Any
 * text is accepted; the server normalizes it and reuses the user's existing spelling on save.
 */
export function SourceCombobox({
  id,
  name,
  defaultValue,
  suggestions,
  maxLength,
  placeholder,
  invalid,
  describedBy,
}: {
  id: string;
  name: string;
  defaultValue: string;
  suggestions: string[];
  maxLength?: number;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <Autocomplete.Root items={suggestions} defaultValue={defaultValue} openOnInputClick>
      <Autocomplete.Input
        render={<Input />}
        id={id}
        name={name}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="isolate z-50 outline-none" sideOffset={4}>
          <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <Autocomplete.List className="outline-0 data-empty:p-0">
              {(source: string) => (
                <Autocomplete.Item
                  key={source}
                  value={source}
                  className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {source}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
