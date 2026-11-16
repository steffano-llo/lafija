import Link from "next/link";
import { setApplicationArchivedAction } from "@/app/dashboard/applications/actions";
import { buttonVariants } from "@/components/ui/button";
import type { Application } from "@/server/applications";
import { ArchiveButton } from "./archive-button";
import { formatAppliedDate, formatSalary } from "./format";

export { formatAppliedDate };

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
            <th scope="col" className="px-3 py-2 font-medium">Stage</th>
            <th scope="col" className="px-3 py-2 font-medium">Applied</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
            <th scope="col" className="px-3 py-2 font-medium">Salary</th>
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
              <td className="px-3 py-2">
                {item.stageName}
                {item.stageArchived && <span className="text-muted-foreground"> (archived)</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{formatAppliedDate(item.appliedAt)}</td>
              <td className="px-3 py-2">{item.source ?? "—"}</td>
              <td className="px-3 py-2 whitespace-nowrap">{formatSalary(item.salaryRange, item.salaryCurrency)}</td>
              <td className="px-3 py-2">
                <div className="flex items-start justify-end gap-2">
                  <Link
                    href={`/dashboard/applications/${item.id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-label={`View ${item.role} at ${item.companyName}`}
                  >
                    View
                  </Link>
                  <Link
                    href={`/dashboard/applications/${item.id}/edit`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-label={`Edit ${item.role} at ${item.companyName}`}
                  >
                    Edit
                  </Link>
                  <ArchiveButton
                    action={setApplicationArchivedAction.bind(null, item.id, !archived)}
                    archived={archived}
                    label={`${item.role} at ${item.companyName}`}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
