"use client";

import { Notice } from "@/components/shell/notice";
import { ui } from "@/components/sales/ui";

export function ErrorFallback({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <Notice title="ShopKhata could not load this page" action={<button type="button" data-slot="button" className={ui.primary} onClick={retry}>Try again</button>}>
    <p>A recent save may still have completed. Check the record before retrying, then reload this page.</p>
    {error.digest && <p>Reference: <code>{error.digest}</code></p>}
  </Notice>;
}
