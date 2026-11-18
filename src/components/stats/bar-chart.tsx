"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type BarDatum = { label: string; value: number };

/**
 * A plain Recharts bar chart. It is decorative for assistive technology: the surrounding
 * `StatsFigure` gives it a text summary (role="img" + aria-label) and a data table, so the chart's
 * own keyboard layer is turned off to avoid a second, unlabeled tab stop.
 */
export function StatsBarChart({
  data,
  valueName,
  horizontal = false,
  height = 260,
  allowDecimals = false,
}: {
  data: BarDatum[];
  /** Tooltip name of the value ("Applications", "Days"). */
  valueName: string;
  /** Bars run left to right with labels on the Y axis (funnel, long stage names). */
  horizontal?: boolean;
  height?: number;
  allowDecimals?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        accessibilityLayer={false}
        margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" allowDecimals={allowDecimals} />
            <YAxis type="category" dataKey="label" width={140} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" interval="preserveStartEnd" />
            <YAxis allowDecimals={allowDecimals} width={40} />
          </>
        )}
        <Tooltip cursor={{ fill: "var(--muted)" }} />
        <Bar dataKey="value" name={valueName} fill="var(--chart-2)" radius={4} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
