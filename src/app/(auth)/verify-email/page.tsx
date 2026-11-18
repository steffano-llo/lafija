import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { verifyEmailOutcome } from "@/components/auth/verify-email-copy";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Verify email · laFija" };

async function Outcome({ searchParams }: Pick<PageProps<"/verify-email">, "searchParams">) {
  const { status, error } = await searchParams;
  const outcome = verifyEmailOutcome({ status, error });
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{outcome.title}</h1>
        </CardTitle>
        <CardDescription role={outcome.kind === "expired" || outcome.kind === "invalid" ? "alert" : undefined}>
          {outcome.body}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/dashboard" className={buttonVariants()}>
          Go to your dashboard
        </Link>
      </CardContent>
    </Card>
  );
}

/** Landing page of the verification link (S17); Better Auth has already verified or refused it. */
export default function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  // searchParams is request data, so the result streams in behind a boundary.
  return (
    <Suspense>
      <Outcome searchParams={searchParams} />
    </Suspense>
  );
}
