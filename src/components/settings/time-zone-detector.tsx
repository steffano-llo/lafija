"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { detectTimeZoneAction } from "@/app/dashboard/settings/actions";

/**
 * Rendered only while the user has no stored time zone: sends the zone this browser reports once,
 * and refreshes the page when it was saved (follow-up due times may have moved). Renders nothing.
 */
export function TimeZoneDetector() {
  const router = useRouter();
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return;
    let active = true;
    detectTimeZoneAction(timeZone)
      .then((result) => {
        if (active && result.saved) router.refresh();
      })
      // Detection is best effort: the zone can still be set in Settings.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [router]);
  return null;
}
