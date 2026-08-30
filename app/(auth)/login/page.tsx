"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { createBrowserClient } from "@/lib/supabase/browser";

function safeDestination(): string {
  const next = new URLSearchParams(window.location.search).get("next");

  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }

  return "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;

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
        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
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
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
