import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { formatDays, formatPercent, formatWeek, rateLabel } from "@/components/stats/format";
import { StatsFigure } from "@/components/stats/stats-figure";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { STAGE_CATEGORY_LABELS } from "@/lib/validation/stage";
import { parseStatsSearchParams, statsHref } from "@/lib/validation/stats";
import { getStats, WEEKS, type Stats } from "@/server/stats";

export const metadata: Metadata = { title: "Statistics · laFija" };

function ArchivedToggle({ includeArchived }: { includeArchived: boolean }) {
  const tab = (active: boolean) => buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" });
  return (
    <nav aria-label="Archived applications" className="flex flex-wrap items-center gap-2">
      <Link href={statsHref(true)} className={tab(includeArchived)} aria-current={includeArchived ? "page" : undefined}>
        Include archived
      </Link>
      <Link href={statsHref(false)} className={tab(!includeArchived)} aria-current={includeArchived ? undefined : "page"}>
        Exclude archived
      </Link>
      <p className="text-sm text-muted-foreground">
        Applies to every metric except the totals per stage, which count only current, non-archived applications.
      </p>
    </nav>
  );
}

function Metrics({ stats }: { stats: Stats }) {
  const { funnel, responseRate } = stats;
  const funnelSteps = [
    { label: "Applied", value: funnel.total },
    { label: "Got a response", value: funnel.responded },
    { label: "Reached an offer", value: funnel.offer },
    { label: "Accepted", value: funnel.accepted },
  ];
  const lastWeek = stats.weekly[stats.weekly.length - 1];
  const currentYear = Number(lastWeek.weekStart.slice(0, 4));
  const weekly = stats.weekly.map((w) => ({ label: formatWeek(w.weekStart, currentYear), value: w.count }));
  const weeklyTotal = stats.weekly.reduce((sum, w) => sum + w.count, 0);

  return (
    <>
      <section aria-labelledby="response-heading" className="flex flex-col gap-1 rounded-lg p-4 ring-1 ring-foreground/10">
        <h2 id="response-heading" className="text-lg font-semibold">
          Response rate
        </h2>
        <p className="text-3xl font-semibold tabular-nums">{formatPercent(responseRate.rate)}</p>
        <p className="text-sm">
          {responseRate.responded} of {responseRate.total} applied applications got a response.
        </p>
        <p className="text-sm">Not applied yet: {stats.notAppliedYet}</p>
        <p className="text-sm text-muted-foreground">
          An application counts as applied once it reaches any stage that is not a Wishlist stage; it got a response
          when it later reached a stage placed after that one (in your current order) that is not Withdrawn or Wishlist.
          Rejections count as responses. Applications only ever in Wishlist stages are counted apart.
        </p>
      </section>

      <StatsFigure
        id="stage-totals"
        title="Applications per stage"
        definition="Current, non-archived applications in each non-archived stage, in board order."
        summary={`Applications per stage: ${stats.stageTotals.map((t) => `${t.name} ${t.count}`).join(", ")}.`}
        chart={{ data: stats.stageTotals.map((t) => ({ label: t.name, value: t.count })), valueName: "Applications" }}
        columns={[{ header: "Stage" }, { header: "Category" }, { header: "Applications", numeric: true }]}
        rows={stats.stageTotals.map((t) => [t.name, STAGE_CATEGORY_LABELS[t.category], t.count])}
        empty="No stages yet."
      />

      <StatsFigure
        id="funnel"
        title="Funnel"
        definition="Applied applications that ever reached each step: a response (as defined above), a stage of category Offer, a stage of category Accepted. Steps are counted independently, so Accepted can exceed Offer. Applications not applied yet are not included."
        summary={`Funnel: ${funnelSteps.map((s) => `${s.label} ${s.value}`).join(", ")}.`}
        chart={{ data: funnelSteps, valueName: "Applications", horizontal: true, height: 200 }}
        columns={[{ header: "Step" }, { header: "Applications", numeric: true }, { header: "Of applied", numeric: true }]}
        rows={funnelSteps.map((s) => [s.label, s.value, formatPercent(funnel.total === 0 ? null : s.value / funnel.total)])}
      />

      <StatsFigure
        id="time-in-stage"
        title="Average time in stage"
        definition="Mean days between entering a stage and the application's next stage change; the current stage counts until now (not for archived applications). Stages without data are not shown."
        summary={`Average days in stage: ${stats.averageTimeInStage.map((s) => `${s.name} ${formatDays(s.averageDays)}`).join(", ")}.`}
        chart={{
          data: stats.averageTimeInStage.map((s) => ({ label: s.name, value: s.averageDays })),
          valueName: "Days",
          allowDecimals: true,
        }}
        columns={[{ header: "Stage" }, { header: "Average", numeric: true }, { header: "Stays measured", numeric: true }]}
        rows={stats.averageTimeInStage.map((s) => [
          s.archived ? `${s.name} (archived stage)` : s.name,
          formatDays(s.averageDays),
          s.samples,
        ])}
        empty="No stage history yet."
      />

      <StatsFigure
        id="weekly"
        title="Applications per week"
        definition={`Applied applications by applied date (else the date they first reached a non-Wishlist stage) over the last ${WEEKS} weeks, weeks starting Monday in your time zone (${stats.timeZone}).`}
        summary={`${weeklyTotal} applications in the last ${WEEKS} weeks: ${stats.weekly
          .filter((w) => w.count > 0)
          .map((w) => `week of ${formatWeek(w.weekStart, currentYear)} ${w.count}`)
          .join(", ") || "none"}.`}
        chart={{ data: weekly, valueName: "Applications" }}
        columns={[{ header: "Week of" }, { header: "Applications", numeric: true }]}
        rows={weekly.map((w) => [w.label, w.value])}
      />

      <StatsFigure
        id="sources"
        title="Applications per source"
        definition='Applied applications and their response rate per source; applications without a source are grouped as "Unknown".'
        summary={`Applications per source: ${stats.sources.map((s) => `${s.source} ${s.count}, ${formatPercent(s.rate)} response`).join("; ")}.`}
        chart={{ data: stats.sources.map((s) => ({ label: s.source, value: s.count })), valueName: "Applications" }}
        columns={[{ header: "Source" }, { header: "Applications", numeric: true }, { header: "Response rate", numeric: true }]}
        rows={stats.sources.map((s) => [s.source, s.count, rateLabel({ responded: s.responded, total: s.count, rate: s.rate })])}
        empty="No applications yet."
      />
    </>
  );
}

async function StatsContent({ searchParams }: { searchParams: PageProps<"/dashboard/stats">["searchParams"] }) {
  const user = await requireUser();
  const { includeArchived } = parseStatsSearchParams(await searchParams);
  const stats = await getStats(getDb(), user.id, { includeArchived });

  return (
    <>
      <ArchivedToggle includeArchived={includeArchived} />
      {stats.totalApplications === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg p-6 ring-1 ring-foreground/10">
          <p>
            {includeArchived
              ? "No applications yet. Statistics appear once you add your first application."
              : "No non-archived applications. Include archived applications to see their statistics."}
          </p>
          {includeArchived && (
            <Link href="/dashboard/applications/new" className={buttonVariants()}>
              New application
            </Link>
          )}
        </div>
      ) : (
        <Metrics stats={stats} />
      )}
    </>
  );
}

export default function StatsPage({ searchParams }: PageProps<"/dashboard/stats">) {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Statistics</h1>
          <p className="text-sm text-muted-foreground">
            Computed from your stage history and stage categories, so renaming a stage never changes them.
          </p>
        </div>
        {/* The session and the filter are request data: they stream in behind this boundary. */}
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <StatsContent searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}
