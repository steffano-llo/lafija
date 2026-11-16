import Link from "next/link";
import { setApplicationArchivedAction } from "@/app/dashboard/applications/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import type { Application } from "@/server/applications";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** Calendar dates are stored without a time zone, so they are formatted as UTC midnight. */
export function formatAppliedDate(value: string | null): string {
  return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : "—";
}

export function ApplicationsTable({ applications, archived }: { applications: Application[]; archived: boolean }) {
  if (applications.length === 0) {
    return (
      <p className="text-muted-foreground">
        {archived ? "No archived applications." : "No applications yet. Add your first one."}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Company</th>
            <th scope="col" className="px-3 py-2 font-medium">Role</th>
            <th scope="col" className="px-3 py-2 font-medium">Applied</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {applications.map((item) => (
            <tr key={item.id} className="border-t border-foreground/10">
              <td className="px-3 py-2 font-medium">{item.companyName}</td>
              <td className="px-3 py-2">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
                    {item.role}
                  </a>
                ) : (
                  item.role
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{formatAppliedDate(item.appliedAt)}</td>
              <td className="px-3 py-2">{item.source ?? "—"}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-2">
                  <Link
                    href={`/dashboard/applications/${item.id}/edit`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-label={`Edit ${item.role} at ${item.companyName}`}
                  >
                    Edit
                  </Link>
                  <form action={setApplicationArchivedAction.bind(null, item.id, !archived)}>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      aria-label={`${archived ? "Unarchive" : "Archive"} ${item.role} at ${item.companyName}`}
                    >
                      {archived ? "Unarchive" : "Archive"}
                    </Button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
