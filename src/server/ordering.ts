import { generateKeyBetween } from "fractional-indexing";

// Board order keys are `fractional-indexing` strings: a key between any two keys always exists,
// so a move rewrites only the moved card. Keys compare by code unit, which is why every SQL
// comparison or sort on them uses `collate "C"` (see ORDER_KEY_SQL in board.ts).

/** Code-unit comparison, the same order as Postgres `collate "C"`. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A key after `last`, or the first key of an empty column. */
export function keyAfter(last: string | null): string {
  return generateKeyBetween(last, null);
}

/**
 * The key that puts a card at `index` in a column whose other cards have `keys` (sorted ascending,
 * without the moved card). An index past the end means the bottom. Concurrent writes can leave two
 * cards with the same key; then the new key goes after the tied ones instead of failing.
 */
export function keyForIndex(keys: readonly string[], index: number): string {
  const at = Math.max(0, Math.min(index, keys.length));
  const before = at > 0 ? keys[at - 1] : null;
  let after: string | null = at < keys.length ? keys[at] : null;
  if (before !== null && after !== null && compareKeys(before, after) >= 0) {
    after = keys.slice(at).find((key) => compareKeys(key, before) > 0) ?? null;
  }
  return generateKeyBetween(before, after);
}
