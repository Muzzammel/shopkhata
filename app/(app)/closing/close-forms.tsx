"use client";

import { useActionState, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { closeBusinessDate, reopenBusinessDate } from "./actions";

/**
 * Close or reopen one shop date. The trigger opens a review drawer that states
 * what the action does; the confirmation and the reopen reason are plain form
 * fields, so the browser enforces them. The server validates everything again.
 */
export function DayCloseControl({ mode, shopId, shopName, businessDate, review }: { mode: "close" | "reopen"; shopId: string; shopName: string; businessDate: string; review: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const closing = mode === "close";
  const [message, submit, busy] = useActionState(async (_previous: string, form: FormData) => {
    if (form.get("confirmed") !== "on") return "Tick the confirmation first.";
    const text = String(form.get("text") ?? "").trim();
    try {
      const result = closing
        ? await closeBusinessDate({ shop_id: shopId, business_date: businessDate, ...(text ? { note: text } : {}) })
        : await reopenBusinessDate({ shop_id: shopId, business_date: businessDate, reason: text });
      router.refresh();
      if (result.ok) {
        setOpen(false);
        return "";
      }
      return result.message;
    } catch {
      return "The result is not confirmed. Refresh to see the current state of this date.";
    }
  }, "");

  const title = closing ? `Close ${businessDate}?` : `Reopen ${businessDate}?`;
  return <>
    <button type="button" className={closing ? ui.primary : ui.secondary} onClick={() => setOpen(true)}>{closing ? "Review close" : "Review reopen"}</button>
    <Drawer open={open} onOpenChange={setOpen} title={title} description={closing ? `Review ${shopName} for ${businessDate} before closing it.` : `Review why ${businessDate} is closed before reopening it.`}>
      {review}
      <form className="grid gap-4" action={submit}>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">{closing ? "Close note (optional)" : "Reason for reopening"}
          <textarea name="text" maxLength={2000} required={!closing} rows={3} className="min-h-24 w-full rounded-xl border border-input bg-card px-3.5 py-2.5 text-[15px] text-foreground focus-visible:border-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25" />
        </label>
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input type="checkbox" name="confirmed" required className="mt-0.5 size-4 shrink-0 accent-foreground" />
          <span>{closing
            ? `I understand that closing blocks every new entry for ${shopName} on ${businessDate} until it is reopened.`
            : `I understand that reopening allows new entries for ${shopName} on ${businessDate} again, and changes this day's operational status.`}</span>
        </label>
        <button className={ui.primary} disabled={busy}>{busy ? "Saving…" : closing ? "Close business date" : "Reopen business date"}</button>
        {message && <p role="alert" className={ui.fieldError}>{message}</p>}
      </form>
    </Drawer>
  </>;
}
