"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { runAuthRequest } from "./auth-errors";

type Mode = "sign-in" | "sign-up";

const copy = {
  "sign-in": {
    title: "Sign in",
    description: "Welcome back. Pick up your search where you left it.",
    submit: "Sign in",
    switchText: "New to laFija?",
    switchLink: "Create an account",
    switchHref: "/sign-up",
  },
  "sign-up": {
    title: "Create your account",
    description: "Track every application, interview and follow-up in one place.",
    submit: "Create account",
    switchText: "Already have an account?",
    switchLink: "Sign in",
    switchHref: "/sign-in",
  },
} as const;

export function AuthForm({
  mode,
  next,
  initialError = null,
}: {
  mode: Mode;
  next: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  const text = copy[mode];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    const failure = await runAuthRequest(
      () =>
        mode === "sign-up"
          ? authClient.signUp.email({ name: String(form.get("name")), email, password })
          : authClient.signIn.email({ email, password }),
      "Something went wrong. Please try again.",
    );

    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function onGoogle() {
    setError(null);
    setPending(true);
    const failure = await runAuthRequest(
      () =>
        authClient.signIn.social({
          provider: "google",
          callbackURL: next,
          // Refusals such as an existing email account come back to sign-in as `?error=`.
          errorCallbackURL: `/sign-in?next=${encodeURIComponent(next)}`,
        }),
      "Google sign-in is not available right now.",
    );
    // On success the browser is already leaving for Google, so the form stays disabled.
    if (failure) {
      setError(failure);
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{text.title}</h1>
        </CardTitle>
        <CardDescription>{text.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {mode === "sign-up" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" required />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              minLength={8}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              required
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Please wait…" : text.submit}
          </Button>
        </form>
        <Button type="button" variant="outline" onClick={onGoogle} disabled={pending}>
          Continue with Google
        </Button>
      </CardContent>
      <CardFooter className="justify-center gap-1 text-sm text-muted-foreground">
        {text.switchText}
        <Link href={`${text.switchHref}?next=${encodeURIComponent(next)}`} className="font-medium text-foreground underline">
          {text.switchLink}
        </Link>
      </CardFooter>
    </Card>
  );
}
