/** State of a one-field settings form (time zone, default currency). */
export type SettingsFormState = {
  value: string;
  error?: string;
  saved?: boolean;
};
