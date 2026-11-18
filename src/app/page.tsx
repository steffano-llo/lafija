import Link from "next/link";
import { TryDemoButton } from "@/components/demo/try-demo-button";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">laFija</h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        Track your job applications, move them through stages and follow your search.
      </p>
      {/* Static links keep this page prerendered; signed-out visitors are sent to sign-in by the proxy. */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/dashboard/board" className={buttonVariants({ size: "lg" })}>
          Open your board
        </Link>
        <Link href="/sign-up" className={buttonVariants({ size: "lg", variant: "outline" })}>
          Create account
        </Link>
      </div>
      <TryDemoButton size="lg" />
    </main>
  );
}
