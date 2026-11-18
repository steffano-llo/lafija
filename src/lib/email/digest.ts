/** One due reminder as it appears in a digest. Company, role and message are user content. */
export type DigestItem = {
  applicationId: string;
  company: string;
  role: string;
  message: string;
  dueAt: Date;
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDue(dueAt: Date, timeZone: string): string {
  // dateStyle/timeStyle cannot be combined with timeZoneName, so the parts are listed.
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(dueAt);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(dueAt);
  }
}

/**
 * The digest of one user's due reminders: English subject ("3 reminders due on laFija"), a plain
 * text part and an HTML part where every piece of user content is escaped. Links go to each
 * application and to the reminders page. Due times are shown in the user's time zone.
 */
export function buildDigestEmail({
  appUrl,
  timeZone,
  items,
}: {
  appUrl: string;
  timeZone: string;
  items: readonly DigestItem[];
}): { subject: string; text: string; html: string } {
  const count = items.length;
  const subject = `${count} reminder${count === 1 ? "" : "s"} due on laFija`;
  const remindersUrl = `${appUrl}/dashboard/reminders`;
  const linkOf = (item: DigestItem) => `${appUrl}/dashboard/applications/${encodeURIComponent(item.applicationId)}`;

  const text = [
    `You have ${count} reminder${count === 1 ? "" : "s"} due on laFija:`,
    "",
    ...items.flatMap((item) => [
      `- ${item.message}`,
      `  ${item.company} · ${item.role} · due ${formatDue(item.dueAt, timeZone)}`,
      `  ${linkOf(item)}`,
      "",
    ]),
    `All reminders: ${remindersUrl}`,
    "",
    "You get this email because email reminders are on in your laFija settings.",
  ].join("\n");

  const listItems = items
    .map(
      (item) =>
        `<li style="margin-bottom:12px"><strong>${escapeHtml(item.message)}</strong><br>` +
        `${escapeHtml(item.company)} · ${escapeHtml(item.role)} · due ${escapeHtml(formatDue(item.dueAt, timeZone))}<br>` +
        `<a href="${escapeHtml(linkOf(item))}">Open application</a></li>`,
    )
    .join("");
  const html =
    `<!doctype html><html><body style="font-family:sans-serif;line-height:1.4">` +
    `<p>You have ${count} reminder${count === 1 ? "" : "s"} due on laFija:</p>` +
    `<ul style="padding-left:20px">${listItems}</ul>` +
    `<p><a href="${escapeHtml(remindersUrl)}">See all reminders</a></p>` +
    `<p style="color:#666;font-size:12px">You get this email because email reminders are on in your laFija settings.</p>` +
    `</body></html>`;

  return { subject, text, html };
}
