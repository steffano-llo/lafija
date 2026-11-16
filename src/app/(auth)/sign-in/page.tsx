import type { Metadata } from "next";
import { Suspense } from "react";
import { signInErrorMessage } from "@/components/auth/auth-errors";
import { AuthForm } from "@/components/auth/auth-form";
import { safeNextPath } from "@/lib/safe-next";

export const metadata: Metadata = { title: "Sign in · laFija" };

async function SignInForm({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { next, error } = await searchParams;
  return (
    <AuthForm
      mode="sign-in"
      next={safeNextPath(typeof next === "string" ? next : null)}
      // Better Auth redirects failed Google sign-ins here with an `error` code.
      initialError={signInErrorMessage(typeof error === "string" ? error : null)}
    />
  );
}

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  // searchParams is request data, so the form streams in behind a boundary.
  return (
    <Suspense>
      <SignInForm searchParams={searchParams} />
    </Suspense>
  );
}
