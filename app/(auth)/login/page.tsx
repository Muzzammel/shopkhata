"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { safeReturnPath } from "@/lib/auth/return-path";
import { clearSessionMarker } from "@/lib/offline/draft-store";
import { createBrowserClient } from "@/lib/supabase/browser";

function safeDestination(): string {
  return safeReturnPath(new URLSearchParams(window.location.search).get("next"), window.location.origin);
}

export default function LoginPage() {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, setIsPending] = useState(false);
  // Reaching this page means there is no live session, so the offline page
  // must stop opening the previous user's draft until someone signs in.
  useEffect(() => { void clearSessionMarker(); }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    // Plain form fields: whatever was typed before the page finished loading is still there.
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    setErrorMessage("");
    setIsPending(true);

    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMessage("Unable to sign in with those credentials.");
        return;
      }

      router.refresh();
      router.replace(safeDestination());
    } catch {
      setErrorMessage("Unable to sign in right now. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <main>
      <section aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in to ShopKhata</h1>
        {/* method="post": a submit before the script has loaded must never put the password in the address bar. */}
        <form method="post" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {errorMessage ? (
            <p role="alert">{errorMessage}</p>
          ) : null}
          <button type="submit" disabled={isPending} aria-busy={isPending}>
            {isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
