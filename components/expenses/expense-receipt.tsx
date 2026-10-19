import { DownloadIcon, ExternalLinkIcon, FileTextIcon, LockIcon, PaperclipIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { fileSize, RECEIPT_TYPE_LABEL } from "@/lib/expense-view";
import { qatarDateTime } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

export type ReceiptFile = { id: string; name: string; contentType: string | null; byteSize: number | null; createdAt: string; openUrl: string | null; downloadUrl: string | null };

/** Private receipts: open or download through short-lived signed links. Receipts are append-only, so there is no remove. */
export function ExpenseReceipt({ files }: { files: ReceiptFile[] }) {
  const action = cn(ui.secondary, "min-h-10 flex-1 px-3 text-[13px] max-sm:min-h-11");
  return <section aria-labelledby="receipt-heading" className="grid gap-3 rounded-3xl border border-border bg-card p-5 sm:p-6">
    <div className="flex items-center justify-between gap-2">
      <h2 id="receipt-heading" data-slot="heading" className="text-base font-semibold">Receipt</h2>
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><LockIcon aria-hidden className="size-3" />Private</span>
    </div>
    {files.length === 0 ? <div className="grid justify-items-center gap-2 rounded-2xl border border-dashed border-input px-4 py-8 text-center">
      <PaperclipIcon aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">No receipt attached</p>
      <p className="text-xs text-muted-foreground">A receipt can only be attached when the expense is recorded.</p>
    </div> : <ul className="grid list-none gap-3 pl-0">
      {files.map((file) => <li key={file.id} className="grid gap-3 rounded-2xl border border-border p-3">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted"><FileTextIcon aria-hidden className="size-4" /></span>
          <span className="grid min-w-0">
            <span className="truncate text-sm font-medium" title={file.name}>{file.name}</span>
            <span className="text-xs text-muted-foreground">{[file.contentType && (RECEIPT_TYPE_LABEL[file.contentType] ?? file.contentType), file.byteSize !== null && fileSize(file.byteSize)].filter(Boolean).join(" · ") || "File"}</span>
            <span className="text-xs text-muted-foreground">Attached {qatarDateTime(file.createdAt)}</span>
          </span>
        </div>
        {file.openUrl ? <div className="flex gap-2">
          <a data-slot="button" href={file.openUrl} target="_blank" rel="noreferrer" aria-label={`Open receipt ${file.name} (new tab)`} className={action}><ExternalLinkIcon aria-hidden />Open</a>
          {file.downloadUrl && <a data-slot="button" href={file.downloadUrl} aria-label={`Download receipt ${file.name}`} className={action}><DownloadIcon aria-hidden />Download</a>}
        </div> : <p className={ui.warn}>This receipt is currently unavailable. Reload the page to try again.</p>}
      </li>)}
    </ul>}
    {files.length > 0 && <p className="text-xs text-muted-foreground">Links expire after 5 minutes; reload the page for fresh ones.</p>}
  </section>;
}
