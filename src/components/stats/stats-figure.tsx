import type { ReactNode } from "react";
import { StatsBarChart, type BarDatum } from "./bar-chart";

export type TableColumn = { header: string; numeric?: boolean };

/**
 * One metric: heading, one-line definition, the chart (exposed to assistive technology as an image
 * with a text summary) and the same numbers as a table under "Show data".
 */
export function StatsFigure({
  id,
  title,
  definition,
  summary,
  chart,
  columns,
  rows,
  empty,
}: {
  id: string;
  title: string;
  definition: string;
  /** Text alternative of the chart, read instead of the SVG. */
  summary: string;
  chart: { data: BarDatum[]; valueName: string; horizontal?: boolean; height?: number; allowDecimals?: boolean } | null;
  columns: TableColumn[];
  rows: ReactNode[][];
  /** Shown instead of the chart and table when there are no rows. */
  empty?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{definition}</p>
      </div>
      {rows.length === 0 && empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <>
          {chart && (
            <div role="img" aria-label={summary}>
              <StatsBarChart {...chart} />
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show data</summary>
            <table className="mt-2 w-full border-collapse text-left">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b">
                  {columns.map((column) => (
                    <th key={column.header} scope="col" className={`py-1 pr-4 font-medium ${column.numeric ? "text-right" : ""}`}>
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((cells, rowIndex) => (
                  <tr key={rowIndex} className="border-b last:border-0">
                    {cells.map((cell, cellIndex) =>
                      cellIndex === 0 ? (
                        <th key={cellIndex} scope="row" className="py-1 pr-4 font-normal">
                          {cell}
                        </th>
                      ) : (
                        <td
                          key={cellIndex}
                          className={`py-1 pr-4 tabular-nums ${columns[cellIndex]?.numeric ? "text-right" : ""}`}
                        >
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
