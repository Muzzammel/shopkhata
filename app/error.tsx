"use client";

import { ErrorFallback } from "./error-fallback";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorFallback error={error} retry={reset} />;
}
