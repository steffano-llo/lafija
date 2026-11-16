const FALLBACK = "/dashboard";

/**
 * Returns `value` only when it is a same-origin path, so a crafted `?next=`
 * link cannot send a freshly signed-in user to another site.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return FALLBACK;
  }
  const url = new URL(value, "http://internal.invalid");
  if (url.origin !== "http://internal.invalid") {
    return FALLBACK;
  }
  return url.pathname + url.search + url.hash;
}
