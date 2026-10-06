"use client";

export function ErrorFallback({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main style={{ maxWidth: 560, margin: "10vh auto", padding: 24 }}>
    <h1>ShopKhata could not load this page</h1>
    <p>A recent save may still have completed. Check the record before retrying, then reload this page.</p>
    {error.digest && <p>Reference: <code>{error.digest}</code></p>}
    <button type="button" onClick={retry}>Try again</button>
  </main>;
}
