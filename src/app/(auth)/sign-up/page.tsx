import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { safeNextPath } from "@/lib/safe-next";

export const metadata: Metadata = { title: "Create account · laFija" };

async function SignUpForm({ searchParams }: Pick<PageProps<"/sign-up">, "searchParams">) {
  const { next } = await searchParams;
  return <AuthForm mode="sign-up" next={safeNextPath(typeof next === "string" ? next : null)} />;
}

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  // searchParams is request data, so the form streams in behind a boundary.
  return (
    <Suspense>
      <SignUpForm searchParams={searchParams} />
    </Suspense>
  );
}
