"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PackageCheckIcon, PencilLineIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";

import { ui } from "@/components/sales/ui";
import { DELIVERY_STATUS_LABEL, deliveryError, parseDeliveryPieces, parseOrderedPieces, reversibleDeliveryIds, type DeliveryCommand, type OrderCorrectionCommand, type PieceDelivery, type ReversalCommand } from "@/lib/invoice-delivery";
import { voidReasonError } from "@/lib/invoice-operations";
import { longDate, personLabel, qatarDateTime } from "@/lib/sales-view";
import { cn } from "@/lib/utils";
import { correctOrderedPieces, recordInvoiceDelivery, reverseInvoiceDelivery } from "./invoice-operation-actions";

const pcs = (n: number) => `${n < 0 ? "\u2212" : ""}${Math.abs(n)} piece${Math.abs(n) === 1 ? "" : "s"}`;

/** Piece delivery of one tracked invoice: totals and history from the delivery ledger, "Record delivery" and "Reverse delivery". */
export function InvoiceDelivery({ shopId, invoiceId, invoiceReference, pieces, people, blockedReason, canReverse = false, reverseBlockedReason = null, canCorrect = false, correctBlockedReason = null }: {
  shopId: string; invoiceId: string; invoiceReference: string; pieces: PieceDelivery; people: Record<string, string>;
  /** Why recording is unavailable (no access, void, inactive shop, closed date, nothing remaining); null when allowed. */
  blockedReason: string | null;
  /** Owner or manager of this shop. Everyone else sees the history only. */
  canReverse?: boolean;
  /** Why no delivery of this invoice can be reversed right now (void, inactive shop, closed date); null when allowed. */
  reverseBlockedReason?: string | null;
  /** Owner or manager of this shop: may correct the ordered pieces. */
  canCorrect?: boolean;
  /** Why the ordered pieces cannot be corrected right now (void, inactive shop, closed date); null when allowed. */
  correctBlockedReason?: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  // The command whose outcome is unknown. A retry resends exactly this, key included; it is never replaced by a new one.
  const [pending, setPending] = useState<DeliveryCommand | null>(null);

  async function send(command: DeliveryCommand) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setMessage(""); setFieldError("");
    try {
      const result = await recordInvoiceDelivery(command);
      if (result.ok) {
        setPending(null); setText("");
        toast.success(`${pcs(command.pieces)} delivered.`);
        router.refresh();
      } else if (result.uncertain) {
        setPending(command); setMessage(result.message);
        toast.error("Saving could not be confirmed.");
      } else {
        // A refusal proves nothing was written under this key: the next attempt may use a new one.
        setPending(null); setMessage(result.message);
        if (result.code === "OVER_DELIVERY" || result.code === "INVOICE_VOID" || result.code === "CLOSED_DATE") router.refresh();
        toast.error("The delivery was not saved.");
      }
    } catch {
      setPending(command); setMessage("Status is uncertain. Retry the exact delivery.");
      toast.error("Saving could not be confirmed.");
    } finally {
      active.current = false; setBusy(false);
    }
  }

  // Reversal of one whole delivery event. As above: an uncertain command is kept and resent unchanged, key included.
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [reverseMessage, setReverseMessage] = useState("");
  const [pendingReversal, setPendingReversal] = useState<ReversalCommand | null>(null);
  const reversible = canReverse && !reverseBlockedReason ? reversibleDeliveryIds(pieces.events) : new Set<string>();
  const byId = new Map(pieces.events.map((event) => [event.id, event]));
  const reversedIds = new Set(pieces.events.map((event) => event.reversesId).filter(Boolean));

  async function sendReversal(command: ReversalCommand) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setReverseMessage(""); setReasonError("");
    try {
      const result = await reverseInvoiceDelivery(command);
      if (result.ok) {
        setPendingReversal(null); setReversing(null); setReason("");
        toast.success("Delivery reversed.");
        router.refresh();
      } else if (result.uncertain) {
        setPendingReversal(command); setReverseMessage(result.message);
        toast.error("Saving could not be confirmed.");
      } else {
        setPendingReversal(null); setReverseMessage(result.message);
        if (result.code === "ALREADY_REVERSED" || result.code === "INVOICE_VOID" || result.code === "CLOSED_DATE" || result.code === "DELIVERY_NOT_FOUND") router.refresh();
        toast.error("The delivery was not reversed.");
      }
    } catch {
      setPendingReversal(command); setReverseMessage("Status is uncertain. Retry the exact reversal.");
      toast.error("Saving could not be confirmed.");
    } finally {
      active.current = false; setBusy(false);
    }
  }

  function submitReversal(deliveryId: string) {
    if (pendingReversal) return void sendReversal(pendingReversal);
    const code = voidReasonError(reason);
    if (code) return setReasonError(deliveryError(code === "INVALID_REQUEST" ? "REASON_TOO_LONG" : code));
    void sendReversal({ shop_id: shopId, invoice_id: invoiceId, delivery_id: deliveryId, reason: reason.trim(), idempotency_key: crypto.randomUUID() });
  }

  function submit() {
    if (pending) return void send(pending);
    const parsed = parseDeliveryPieces(text, pieces.remaining);
    if ("error" in parsed) return setFieldError(parsed.error);
    void send({ shop_id: shopId, invoice_id: invoiceId, pieces: parsed.pieces, idempotency_key: crypto.randomUUID() });
  }

  return <section aria-labelledby="delivery-heading" data-piece-delivery className="grid gap-4 border-t border-border pt-5">
    <h2 id="delivery-heading" data-slot="heading" className="text-base font-semibold">Delivery</h2>
    <dl aria-label="Piece delivery" className="grid grid-cols-2 gap-3 text-sm tabular-nums sm:grid-cols-4">
      {[
        ["Ordered pieces", String(pieces.ordered)],
        ["Delivered pieces", String(pieces.delivered)],
        ["Remaining pieces", String(pieces.remaining)],
        ["Delivery status", DELIVERY_STATUS_LABEL[pieces.status]],
      ].map(([label, value]) => <div key={label} className="grid gap-0.5 rounded-2xl bg-muted p-3">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd data-delivery-figure={label} className="text-base font-semibold">{value}</dd>
      </div>)}
    </dl>
    {pieces.ordered !== pieces.originalOrdered && <p data-original-ordered className="text-[13px] text-muted-foreground">Originally ordered {pcs(pieces.originalOrdered)}.</p>}

    <OrderedPiecesCorrection shopId={shopId} invoiceId={invoiceId} pieces={pieces} people={people} canCorrect={canCorrect} blockedReason={correctBlockedReason} />

    <div className="grid gap-2">
      <h3 data-slot="heading" className="text-sm font-semibold">Delivery history</h3>
      {pieces.events.length === 0 ? <p className="text-sm text-muted-foreground">No pieces delivered yet.</p> : <ul aria-label="Delivery history" className="grid list-none divide-y divide-border pl-0">
        {pieces.events.map((event) => {
          const original = event.reversesId ? byId.get(event.reversesId) : undefined;
          const open = reversing === event.id;
          return <li key={event.id} data-delivery-event={event.reversesId ? "reversal" : "delivery"} className="grid gap-2 py-2.5 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span className="min-w-0 text-muted-foreground">
                {event.reversesId
                  ? <>Reversal of the {original ? `${pcs(original.pieces)} delivered on ${longDate(original.businessDate)}` : "delivery"} · reason: <span data-reversal-reason className="text-foreground">{event.reason}</span> · </>
                  : <>{event.withSale ? "With the sale" : "Later delivery"}{reversedIds.has(event.id) ? <> · <span data-delivery-reversed className="font-semibold text-foreground">Reversed</span></> : null} · </>}
                business date {longDate(event.businessDate)} · recorded {qatarDateTime(event.recordedAt)} · by {personLabel(people, event.createdBy)} · invoice {invoiceReference}
              </span>
              <span className="flex items-center gap-3">
                <strong className="font-semibold tabular-nums">{pcs(event.pieces)}</strong>
                {reversible.has(event.id) && !open && <button data-slot="button" type="button" data-print="hide" className={ui.quiet} disabled={busy || Boolean(pendingReversal)}
                  aria-label={`Reverse delivery of ${pcs(event.pieces)} on ${longDate(event.businessDate)}`}
                  onClick={() => { setReversing(event.id); setReason(""); setReasonError(""); setReverseMessage(""); }}><Undo2Icon aria-hidden className="size-4" />Reverse</button>}
              </span>
            </div>
            {open && <form noValidate aria-label="Reverse delivery" data-print="hide" className="grid gap-2 rounded-2xl border border-border p-4" onSubmit={(e) => { e.preventDefault(); submitReversal(event.id); }}>
              <label data-slot="label" htmlFor="reversal-reason" className={ui.label}>Reason for reversing this delivery</label>
              <textarea data-slot="textarea" id="reversal-reason" rows={3} required maxLength={2000} className={cn(ui.field, "h-auto min-h-24 py-2.5")}
                value={pendingReversal ? pendingReversal.reason : reason} disabled={busy || Boolean(pendingReversal)} onChange={(e) => { setReason(e.target.value); setReasonError(""); }}
                aria-invalid={Boolean(reasonError) || undefined} aria-describedby={reasonError ? "reversal-reason-error" : "reversal-reason-hint"} />
              {reasonError ? <p id="reversal-reason-error" data-slot="field-error" className={ui.fieldError}>{reasonError}</p>
                : <p id="reversal-reason-hint" className="text-xs text-muted-foreground">Reverses all {pcs(event.pieces)} of this delivery. Posted on today&apos;s business date; the original delivery stays in the history. Money on the invoice does not change.</p>}
              {reverseMessage && <p role="alert" className={ui.danger}>{reverseMessage}</p>}
              <div className="flex flex-wrap gap-2">
                <button data-slot="button" type="submit" className={cn(ui.primary, "min-h-11")} disabled={busy}><Undo2Icon aria-hidden />{busy ? "Saving…" : pendingReversal ? "Retry exact reversal" : "Reverse delivery"}</button>
                {!pendingReversal && <button data-slot="button" type="button" className={cn(ui.ghost, "min-h-11")} disabled={busy} onClick={() => { setReversing(null); setReverseMessage(""); }}>Cancel</button>}
              </div>
            </form>}
          </li>;
        })}
      </ul>}
      {canReverse && reverseBlockedReason && pieces.events.length > 0 && <p data-reversal-blocked className="text-[13px] text-muted-foreground">{reverseBlockedReason}</p>}
    </div>

    {blockedReason && !pending ? <p data-delivery-blocked className="text-[13px] text-muted-foreground">{blockedReason}</p>
      : <form noValidate aria-label="Record delivery" data-print="hide" className="grid gap-2 rounded-2xl border border-border p-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-40 flex-1 gap-1.5">
            <label data-slot="label" htmlFor="delivery-pieces" className={ui.label}>Pieces delivered now</label>
            <input data-slot="input" id="delivery-pieces" inputMode="numeric" pattern="[0-9]*" autoComplete="off" className={cn(ui.field, "tabular-nums")}
              value={pending ? String(pending.pieces) : text} disabled={busy || Boolean(pending)} onChange={(event) => { setText(event.target.value); setFieldError(""); }}
              aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? "delivery-pieces-error" : "delivery-pieces-hint"} />
          </div>
          <button data-slot="button" type="submit" className={cn(ui.primary, "min-h-11")} disabled={busy}><PackageCheckIcon aria-hidden />{busy ? "Saving…" : pending ? "Retry exact delivery" : "Record delivery"}</button>
        </div>
        {fieldError ? <p id="delivery-pieces-error" data-slot="field-error" className={ui.fieldError}>{fieldError}</p>
          : <p id="delivery-pieces-hint" className="text-xs text-muted-foreground">Up to {pcs(pieces.remaining)}. Recorded on today&apos;s business date. Money on the invoice does not change.</p>}
        {message && <p role="alert" className={ui.danger}>{message}</p>}
      </form>}
  </section>;
}

const ORDER_REASON_ERROR: Record<string, string> = {
  REASON_REQUIRED: "Enter the reason for correcting the ordered pieces.",
  REASON_TOO_SHORT: "Explain the correction in at least 10 characters.",
  INVALID_REQUEST: "Keep the reason under 2000 characters.",
};

/** History of ordered-piece corrections and, for an owner or manager, "Correct ordered pieces". Money never changes. */
function OrderedPiecesCorrection({ shopId, invoiceId, pieces, people, canCorrect, blockedReason }: {
  shopId: string; invoiceId: string; pieces: PieceDelivery; people: Record<string, string>; canCorrect: boolean; blockedReason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  // The command whose outcome is unknown. A retry resends exactly this, key and expected quantity included.
  const [pending, setPending] = useState<OrderCorrectionCommand | null>(null);

  async function send(command: OrderCorrectionCommand) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setMessage("");
    try {
      const result = await correctOrderedPieces(command);
      if (result.ok) {
        setPending(null); setOpen(false); setText(""); setReason("");
        toast.success(`Ordered pieces corrected to ${command.ordered_pieces}.`);
        router.refresh();
      } else if (result.uncertain) {
        setPending(command); setMessage(result.message);
        toast.error("Saving could not be confirmed.");
      } else {
        // A refusal proves nothing was written under this key: the next attempt may use a new one.
        setPending(null); setMessage(result.message);
        if (["STALE_ORDERED_PIECES", "BELOW_DELIVERED", "INVOICE_VOID", "CLOSED_DATE"].includes(result.code ?? "")) router.refresh();
        toast.error("The correction was not saved.");
      }
    } catch {
      setPending(command); setMessage("Status is uncertain. Retry the exact correction.");
      toast.error("Saving could not be confirmed.");
    } finally {
      active.current = false; setBusy(false);
    }
  }

  function submit() {
    if (pending) return void send(pending);
    const parsed = parseOrderedPieces(text, pieces);
    const code = voidReasonError(reason);
    setFieldError("error" in parsed ? parsed.error : "");
    setReasonError(code ? ORDER_REASON_ERROR[code] ?? deliveryError(code) : "");
    if ("error" in parsed || code) return;
    void send({ shop_id: shopId, invoice_id: invoiceId, expected_ordered_pieces: pieces.ordered, ordered_pieces: parsed.pieces, reason: reason.trim(), idempotency_key: crypto.randomUUID() });
  }

  if (pieces.corrections.length === 0 && !canCorrect) return null;
  return <div className="grid gap-2">
    <h3 data-slot="heading" className="text-sm font-semibold">Ordered piece corrections</h3>
    {pieces.corrections.length === 0 ? <p className="text-sm text-muted-foreground">No corrections.</p> : <ul aria-label="Ordered piece corrections" className="grid list-none divide-y divide-border pl-0">
      {pieces.corrections.map((c) => <li key={c.id} data-order-correction className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0">
        <span className="min-w-0 text-muted-foreground">
          Reason: <span data-order-correction-reason className="text-foreground">{c.reason}</span> · business date {longDate(c.businessDate)} · recorded {qatarDateTime(c.recordedAt)} · by {personLabel(people, c.createdBy)}
        </span>
        <strong className="font-semibold tabular-nums" aria-label={`${c.before} to ${c.after} pieces`}>{c.before} → {c.after}</strong>
      </li>)}
    </ul>}
    {canCorrect && (blockedReason && !pending ? <p data-order-correction-blocked className="text-[13px] text-muted-foreground">{blockedReason}</p>
      : !open && !pending ? <div><button data-slot="button" type="button" data-print="hide" className={ui.quiet} onClick={() => { setOpen(true); setText(String(pieces.ordered)); setMessage(""); }}>
        <PencilLineIcon aria-hidden className="size-4" />Correct ordered pieces</button></div>
      : <form noValidate aria-label="Correct ordered pieces" data-print="hide" className="grid gap-2 rounded-2xl border border-border p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label data-slot="label" htmlFor="ordered-pieces" className={ui.label}>Corrected ordered pieces</label>
        <input data-slot="input" id="ordered-pieces" inputMode="numeric" pattern="[0-9]*" autoComplete="off" className={cn(ui.field, "max-w-48 tabular-nums")}
          value={pending ? String(pending.ordered_pieces) : text} disabled={busy || Boolean(pending)} onChange={(e) => { setText(e.target.value); setFieldError(""); }}
          aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? "ordered-pieces-error" : "ordered-pieces-hint"} />
        {fieldError ? <p id="ordered-pieces-error" data-slot="field-error" className={ui.fieldError}>{fieldError}</p>
          : <p id="ordered-pieces-hint" className="text-xs text-muted-foreground">Now {pcs(pieces.ordered)}; at least {pcs(Math.max(pieces.delivered, 1))}. Recorded on today&apos;s business date; the original quantity stays in the history. Money on the invoice does not change.</p>}
        <label data-slot="label" htmlFor="ordered-reason" className={ui.label}>Reason for the correction</label>
        <textarea data-slot="textarea" id="ordered-reason" rows={3} required maxLength={2000} className={cn(ui.field, "h-auto min-h-24 py-2.5")}
          value={pending ? pending.reason : reason} disabled={busy || Boolean(pending)} onChange={(e) => { setReason(e.target.value); setReasonError(""); }}
          aria-invalid={Boolean(reasonError) || undefined} aria-describedby={reasonError ? "ordered-reason-error" : undefined} />
        {reasonError && <p id="ordered-reason-error" data-slot="field-error" className={ui.fieldError}>{reasonError}</p>}
        {message && <p role="alert" className={ui.danger}>{message}</p>}
        <div className="flex flex-wrap gap-2">
          <button data-slot="button" type="submit" className={cn(ui.primary, "min-h-11")} disabled={busy}><PencilLineIcon aria-hidden />{busy ? "Saving…" : pending ? "Retry exact correction" : "Save correction"}</button>
          {!pending && <button data-slot="button" type="button" className={cn(ui.ghost, "min-h-11")} disabled={busy} onClick={() => { setOpen(false); setMessage(""); setFieldError(""); setReasonError(""); }}>Cancel</button>}
        </div>
      </form>)}
  </div>;
}
