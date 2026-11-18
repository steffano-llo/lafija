/**
 * Ids are random UUIDs. Anything that cannot be one (wrong type, empty, too long, or with a NUL
 * byte, which Postgres text rejects with an error) is treated as unknown before it reaches a query.
 */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && !value.includes("\0");
}
