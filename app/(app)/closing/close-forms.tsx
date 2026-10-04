"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { closeBusinessDate, reopenBusinessDate } from "./actions";
import styles from "../customers/operations.module.css";

/**
 * Close or reopen one shop date. The fields are plain form fields: the browser
 * enforces the confirmation (and the reopen reason), and nothing typed before
 * the page finishes loading is lost. The server validates everything again.
 */
export function DayCloseForm({ mode, shopId, shopName, businessDate }: { mode: "close" | "reopen"; shopId: string; shopName: string; businessDate: string }) {
  const router = useRouter();
  const closing = mode === "close";
  const [message, submit, busy] = useActionState(async (_previous: string, form: FormData) => {
    if (form.get("confirmed") !== "on") return "Tick the confirmation first.";
    const text = String(form.get("text") ?? "").trim();
    try {
      const result = closing
        ? await closeBusinessDate({ shop_id: shopId, business_date: businessDate, ...(text ? { note: text } : {}) })
        : await reopenBusinessDate({ shop_id: shopId, business_date: businessDate, reason: text });
      router.refresh();
      return result.ok ? "" : result.message;
    } catch {
      return "The result is not confirmed. Refresh to see the current state of this date.";
    }
  }, "");

  return <form className={styles.formGrid} action={submit}>
    <label>{closing ? "Close note (optional)" : "Reason for reopening"}
      <textarea name="text" maxLength={2000} required={!closing} />
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input type="checkbox" name="confirmed" required style={{ width: "auto" }} />
      {closing
        ? `I understand that closing blocks every new entry for ${shopName} on ${businessDate} until it is reopened.`
        : `I understand that reopening allows new entries for ${shopName} on ${businessDate} again.`}
    </label>
    <button disabled={busy}>{busy ? "Saving…" : closing ? "Close business date" : "Reopen business date"}</button>
    {message && <p role="alert">{message}</p>}
  </form>;
}
