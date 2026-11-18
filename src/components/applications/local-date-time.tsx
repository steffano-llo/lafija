"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/**
 * An instant in the reader's time zone. The server does not know that zone, so the server render
 * (and hydration) shows UTC and the browser switches to local time right after.
 */
export function LocalDateTime({ value }: { value: string }) {
  const date = new Date(value);
  const text = useSyncExternalStore(
    subscribe,
    () => local.format(date),
    () => `${utc.format(date)} UTC`,
  );
  return <time dateTime={value}>{text}</time>;
}

/** `YYYY-MM-DDTHH:mm` in the browser's time zone, for a `datetime-local` input. */
export function toLocalInputValue(value: string): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value means in the browser's time zone, as ISO; "" when blank or invalid. */
export function fromLocalInputValue(value: string): string {
  if (value.trim() === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}
