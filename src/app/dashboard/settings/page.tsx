import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DashboardHeader } from "@/components/reminders/dashboard-header";
import { EmailRemindersForm } from "@/components/settings/email-reminders-form";
import { SettingsSelectForm } from "@/components/settings/settings-select-form";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { CURRENCIES, FALLBACK_TIME_ZONE } from "@/lib/validation/settings";
import { getEmailReminders, getUserSettings, listTimeZones } from "@/server/settings";
import { setDefaultCurrencyAction, setEmailRemindersAction, setTimeZoneAction } from "./actions";

export const metadata: Metadata = { title: "Settings · laFija" };

const currencyOptions = CURRENCIES.map((code) => ({ value: code, label: code }));

async function SettingsForms() {
  const user = await requireUser();
  const db = getDb();
  const [settings, zones, emailReminders] = await Promise.all([
    getUserSettings(db, user.id),
    listTimeZones(db),
    getEmailReminders(db, user.id),
  ]);

  return (
    <>
      <section aria-labelledby="time-zone-heading" className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
        <h2 id="time-zone-heading" className="text-lg font-semibold">
          Time zone
        </h2>
        {settings.timeZone === null && (
          <p className="text-sm text-muted-foreground">
            Not detected yet: {FALLBACK_TIME_ZONE} is used until your browser reports one or you choose one.
          </p>
        )}
        <SettingsSelectForm
          id="time-zone"
          name="timeZone"
          label="Your time zone"
          help="Automatic follow-ups are due at 9:00 a.m. in this zone, and applied dates filled in for you use its calendar. Changing it moves open follow-ups you have not edited or snoozed to 9:00 a.m. in the new zone."
          options={zones.map((zone) => ({ value: zone, label: zone }))}
          value={settings.timeZone ?? ""}
          action={setTimeZoneAction}
        />
      </section>
      <section aria-labelledby="currency-heading" className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
        <h2 id="currency-heading" className="text-lg font-semibold">
          Currency
        </h2>
        <SettingsSelectForm
          id="default-currency"
          name="defaultCurrency"
          label="Default salary currency"
          help="Preselected when you add a salary to an application. Changing it leaves existing applications as they are."
          options={currencyOptions}
          value={settings.defaultCurrency}
          action={setDefaultCurrencyAction}
        />
      </section>
      <section aria-labelledby="email-heading" className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
        <h2 id="email-heading" className="text-lg font-semibold">
          Email
        </h2>
        <EmailRemindersForm enabled={emailReminders} action={setEmailRemindersAction} />
      </section>
    </>
  );
}

export default function SettingsPage() {
  return (
    <>
      <DashboardHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Automatic follow-up days are set on the{" "}
            <Link href="/dashboard/reminders" className="underline underline-offset-4">
              Reminders
            </Link>{" "}
            page.
          </p>
        </div>
        {/* The session read is request data: the forms stream in behind this boundary. */}
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <SettingsForms />
        </Suspense>
      </main>
    </>
  );
}
