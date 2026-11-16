const FALLBACK = "/dashboard";

// Control characters are stripped by URL parsing and backslashes are read as slashes,
// both of which can turn an innocent-looking path into `//host`.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
// `.` and `..` segments (also percent-encoded) collapse during normalization.
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$|\?|#)/i;

/**
 * Returns `value` only when it is a same-origin path, so a crafted `?next=`
 * link cannot send a freshly signed-in user to another site.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    UNSAFE_CHARACTERS.test(value) ||
    DOT_SEGMENT.test(value)
  ) {
    return FALLBACK;
  }
  const url = new URL(value, "http://internal.invalid");
  const path = url.pathname + url.search + url.hash;
  // Defense in depth: never hand the router anything it could read as another origin.
  if (url.origin !== "http://internal.invalid" || path.startsWith("//")) {
    return FALLBACK;
  }
  return path;
}
