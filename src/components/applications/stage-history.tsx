import type { HistoryEntry } from "@/server/board";
import { LocalDateTime } from "./local-date-time";

/** Stage changes of one application, oldest first: "Created in Applied", then "Applied → Screening"… */
export function StageHistory({ entries }: { entries: HistoryEntry[] }) {
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="text-lg font-semibold">
        Stage history
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stage changes recorded.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-3">
              <span className="text-muted-foreground">
                <LocalDateTime value={entry.at.toISOString()} />
              </span>
              <span>{entry.label}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
