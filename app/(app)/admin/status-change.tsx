"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { CircleAlertIcon, PencilLineIcon, PowerIcon, PowerOffIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { STATUS_REASON_MAX } from "@/lib/shop-admin";
import { cn } from "@/lib/utils";

import { Comparison } from "../invoice-operations";

export type StatusResult = { ok: true } | { ok: false; message: string };

export function Failure({ title, message }: { title: string; message: string }) {
  return <Alert variant="destructive" className="border-destructive/40 bg-danger-soft"><CircleAlertIcon /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="grid content-start gap-1.5">
    <label data-slot="label" htmlFor={id} className={ui.label}>{label}</label>
    {children}
    {hint && !error && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    {error && <p id={`${id}-error`} data-slot="field-error" className={ui.fieldError}>{error}</p>}
  </div>;
}

/**
 * Deactivate or reactivate one shop or account: the button, then a mandatory reason, then a review of
 * current against new status with what the change does, then one governed RPC. Nothing is deleted.
 * `noun` is "shop" or "account"; `effects` lists, in words, what the change will do.
 */
export function StatusChange({ noun, name, isActive, effects, submit, onDone }: {
  noun: "shop" | "account"; name: string; isActive: boolean; effects: string[];
  submit: (reason: string) => Promise<StatusResult>; onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<"idle" | "reason" | "review">("idle");
  const [reason, setReason] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const verb = isActive ? "Deactivate" : "Reactivate";
  const change = isActive ? "deactivation" : "reactivation";
  const action = `${verb} ${noun}`;
  const trimmed = reason.trim();
  const issue = !trimmed ? `Enter the reason for ${isActive ? "deactivating" : "reactivating"} this ${noun}.`
    : trimmed.length > STATUS_REASON_MAX ? `Use ${STATUS_REASON_MAX} characters or fewer.` : undefined;
  const status = (active: boolean) => active ? "Active" : "Inactive";

  function toReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setChecked(true);
    if (issue) { document.getElementById(`${noun}-status-reason`)?.focus(); return; }
    setMessage(""); setStep("review");
  }

  async function confirm() {
    if (busy) return;
    setBusy(true); setMessage("");
    let result: StatusResult;
    try { result = await submit(trimmed); } catch { result = { ok: false, message: "The change was not saved. Refresh to see the current status." }; }
    setBusy(false);
    if (result.ok) onDone(`${name} ${isActive ? "deactivated" : "reactivated"}.`);
    else { setMessage(result.message); setStep("reason"); }
  }

  return <section aria-labelledby={`${noun}-status-heading`} className="grid gap-3 border-t border-border pt-5">
    <h3 id={`${noun}-status-heading`} data-slot="heading" className="text-sm font-semibold">{noun === "shop" ? "Shop status" : "Account status"}</h3>
    {step === "idle" && <>
      <p className="text-sm text-muted-foreground">{isActive
        ? `Active. Deactivating keeps every record and its history; it can be reactivated later.`
        : `Inactive. Its records and history are kept. Reactivating lets it be used again.`}</p>
      <button data-slot="button" type="button" className={cn(ui.secondary, "justify-self-start", isActive && "text-destructive")} onClick={() => { setStep("reason"); setChecked(false); setMessage(""); }}>
        {isActive ? <PowerOffIcon aria-hidden /> : <PowerIcon aria-hidden />}{action}
      </button>
    </>}
    {step === "reason" && <form noValidate aria-label={action} className="grid gap-4" onSubmit={toReview}>
      <Field id={`${noun}-status-reason`} label="Reason" error={checked ? issue : undefined} hint="Required. Saved with the change in the history.">
        <textarea data-slot="textarea" id={`${noun}-status-reason`} rows={3} maxLength={STATUS_REASON_MAX} value={reason} className={cn(ui.field, "h-auto min-h-24 py-2.5")}
          aria-invalid={Boolean(checked && issue) || undefined} aria-describedby={checked && issue ? `${noun}-status-reason-error` : `${noun}-status-reason-hint`}
          onChange={(event) => { setReason(event.target.value); setMessage(""); }} />
      </Field>
      {message && <Failure title="The status was not changed" message={message} />}
      <div className="flex flex-wrap gap-2">
        <button data-slot="button" className={cn(ui.primary, "flex-1")}>Review {change}</button>
        <button data-slot="button" type="button" className={ui.secondary} onClick={() => { setStep("idle"); setMessage(""); }}>Cancel</button>
      </div>
    </form>}
    {step === "review" && <div className="grid gap-4">
      <Comparison label={`Requested ${noun} status change`} rows={[{ label: "Status", current: status(isActive), requested: status(!isActive) }]} />
      <p className="grid gap-0.5 text-sm"><span className="text-xs font-medium text-muted-foreground">Reason</span><span data-slot="status-reason" className="whitespace-pre-line [overflow-wrap:anywhere]">{trimmed}</span></p>
      <ul aria-label={`What ${change} does`} className="grid list-none gap-2 pl-0">{effects.map((effect) => <li key={effect} className={isActive ? ui.danger : ui.warn}>{effect}</li>)}</ul>
      {busy && <p role="status" className="text-sm font-medium">Saving…</p>}
      <div className="flex flex-wrap gap-2">
        <button data-slot="button" type="button" className={cn(ui.primary, "flex-1", isActive && "bg-destructive text-white hover:bg-destructive/90")} disabled={busy} onClick={() => void confirm()}>{busy ? "Saving…" : `Confirm: ${action.toLowerCase()}`}</button>
        <button data-slot="button" type="button" className={ui.secondary} disabled={busy} onClick={() => setStep("reason")}><PencilLineIcon aria-hidden />Edit</button>
      </div>
    </div>}
  </section>;
}
