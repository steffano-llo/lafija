/**
 * Application sources (S20). Stored normalized: trimmed with inner whitespace collapsed. On save the
 * server stores the user's existing form when one matches case-insensitively, else the preset
 * spelling when one matches, else the normalized input (`canonicalSourceSql` in
 * `src/server/applications.ts`; migration `0010_unify_sources` applied the same rule to old rows).
 */
export const SOURCE_PRESETS = ["LinkedIn", "Computrabajo", "Bumeran", "Get on Board", "Indeed", "Referido"] as const;

/** Trimmed, every whitespace run collapsed to one space; blank is null. */
export function normalizeSource(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

/** The preset spelling of a case-insensitive match, if any. */
export function presetSource(value: string): string | undefined {
  const key = value.toLowerCase();
  return SOURCE_PRESETS.find((preset) => preset.toLowerCase() === key);
}

/** Suggestions for the source field: the user's forms in the given order, then the presets, case-insensitively unique. */
export function sourceSuggestions(userSources: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of [...userSources, ...SOURCE_PRESETS]) {
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}
