import { z } from "zod";

import type { EntryError, EntryRow, InvoiceEntryInput } from "@/lib/invoice-entry";

// Local drafts are a convenience copy of unsaved input. They are never
// financial truth: only a confirmed submit_batch receipt is.

export const DRAFT_SCHEMA_VERSION = 1;
/** Plain drafts untouched this long are removed; drafts with a submission in doubt are kept. */
export const STALE_DRAFT_DAYS = 30;
/** Automatic attempts after a reconnect, then the user must retry by hand. */
export const AUTO_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

const rowSchema = z.object({
  rowId: z.string().min(1), invoiceId: z.string(), total: z.string(), received: z.string(), delivered: z.boolean(),
  customerId: z.string(), customerName: z.string(), customerMobile: z.string(), note: z.string().optional(),
});
const customerSchema = z.object({ id: z.string(), name: z.string().nullable(), mobile: z.string().nullable(), public_id: z.string() });
const payloadSchema = z.object({
  shopId: z.string(), businessDate: z.string(), isBackdated: z.boolean(), backdatedReason: z.string(),
  idempotencyKey: z.string().min(1), rows: z.array(rowSchema).min(1),
});
const submissionSchema = z.object({
  type: z.literal("invoice_batch"),
  shopId: z.string(),
  idempotencyKey: z.string().min(1),
  payload: payloadSchema,
  /** queued: never sent. uncertain: sent at least once without a confirmed answer. */
  status: z.enum(["queued", "uncertain"]),
  queuedAt: z.string(),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
});
const conflictSchema = z.object({ kind: z.string(), message: z.string(), errors: z.array(z.object({ rowId: z.string(), field: z.string(), message: z.string(), code: z.string().optional() })) });
const draftSchema = z.object({
  key: z.string(),
  schemaVersion: z.literal(DRAFT_SCHEMA_VERSION),
  userId: z.string().min(1),
  shopId: z.string().min(1),
  businessDate: z.string(),
  savedOn: z.string(),
  backdatedReason: z.string().default(""),
  rows: z.array(rowSchema).min(1),
  customers: z.record(z.string(), customerSchema).default({}),
  idempotencyKey: z.string().min(1),
  submission: submissionSchema.nullable().default(null),
  conflict: conflictSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DraftCustomer = z.infer<typeof customerSchema>;
export type DraftSubmission = z.infer<typeof submissionSchema>;
export type StoredDraft = z.infer<typeof draftSchema>;
export type ConflictKind = "duplicate_invoice" | "customer" | "closed_date" | "date_changed" | "idempotency" | "validation" | "authorization" | "reauth" | "unavailable";
export type DraftConflict = { kind: ConflictKind; message: string; errors: EntryError[] };

/** One draft per user per shop; the key is the privacy boundary on a shared device. */
export function draftKey(userId: string, shopId: string): string {
  return `${userId}:${shopId}`;
}

export function isBlankRows(rows: readonly EntryRow[]): boolean {
  return rows.length <= 1 && rows.every((row) => !(row.invoiceId.trim() || row.total.trim() || row.received.trim() || row.delivered
    || row.customerId || row.customerName.trim() || row.customerMobile.trim() || row.note?.trim()));
}

export function serializeDraft(input: {
  userId: string; shopId: string; businessDate: string; today: string; backdatedReason: string; rows: readonly EntryRow[];
  customers: Record<string, DraftCustomer>; idempotencyKey: string; submission: DraftSubmission | null;
  conflict: DraftConflict | null; createdAt: string; now: string;
}): StoredDraft {
  const rowIds = new Set(input.rows.map((row) => row.rowId));
  return {
    key: draftKey(input.userId, input.shopId), schemaVersion: DRAFT_SCHEMA_VERSION, userId: input.userId, shopId: input.shopId,
    businessDate: input.businessDate, savedOn: input.today, backdatedReason: input.backdatedReason,
    rows: input.rows.map((row) => ({ ...row })),
    // Only customers still referenced by a row are kept on the device.
    customers: Object.fromEntries(Object.entries(input.customers).filter(([rowId, customer]) =>
      rowIds.has(rowId) && input.rows.some((row) => row.rowId === rowId && row.customerId === customer.id))),
    idempotencyKey: input.idempotencyKey, submission: input.submission, conflict: input.conflict,
    createdAt: input.createdAt, updatedAt: input.now,
  };
}

/**
 * Reads a stored record back. Older records missing later-added fields get
 * defaults; a record from a newer schema, a corrupt record, or one stored
 * under another user/shop is ignored rather than guessed at.
 */
export function normalizeStoredDraft(raw: unknown, owner: { userId: string; shopId: string }): StoredDraft | null {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return null;
  const draft = parsed.data;
  if (draft.userId !== owner.userId || draft.shopId !== owner.shopId || draft.key !== draftKey(owner.userId, owner.shopId)) return null;
  if (draft.submission && (draft.submission.shopId !== draft.shopId || draft.submission.payload.shopId !== draft.shopId
    || draft.submission.idempotencyKey !== draft.submission.payload.idempotencyKey)) return null;
  return draft;
}

/** A draft that was following "today" moves to the current day; an explicit backdate stays. */
export function restoreBusinessDate(draft: Pick<StoredDraft, "businessDate" | "savedOn">, today: string): string {
  return draft.businessDate >= draft.savedOn || draft.businessDate > today ? today : draft.businessDate;
}

export function isStaleDraft(draft: Pick<StoredDraft, "updatedAt" | "submission">, now: Date): boolean {
  return !draft.submission && now.getTime() - Date.parse(draft.updatedAt) > STALE_DRAFT_DAYS * 86_400_000;
}

export function newSubmission(payload: InvoiceEntryInput, now: string): DraftSubmission {
  return { type: "invoice_batch", shopId: payload.shopId, idempotencyKey: payload.idempotencyKey, payload, status: "queued", queuedAt: now, attempts: 0, lastError: null };
}

export type SaveOutcome =
  | { kind: "saved" }
  /** Sent, but no confirmed answer came back. */
  | { kind: "uncertain" }
  /** The server refused before evaluating the key, so nothing new is known about it. */
  | { kind: "blocked"; reason: "reauth" | "authorization" | "unavailable" }
  /** The server proved this key is not committed with this payload. */
  | { kind: "rejected"; conflict: Exclude<ConflictKind, "authorization" | "reauth" | "unavailable"> };

const CUSTOMER_FIELDS = new Set(["customer", "customerId"]);
const INVOICE_FIELDS = new Set(["invoiceId", "invoice_number"]);

export function classifySaveResult(result: { ok: boolean; uncertain?: boolean; code?: string; errors: readonly EntryError[] }): SaveOutcome {
  if (result.ok) return { kind: "saved" };
  if (result.uncertain) return { kind: "uncertain" };
  switch (result.code) {
    case "UNAUTHENTICATED": return { kind: "blocked", reason: "reauth" };
    case "UNAUTHORIZED_SHOP":
    case "INSUFFICIENT_ROLE": return { kind: "blocked", reason: "authorization" };
    case "UNAVAILABLE": return { kind: "blocked", reason: "unavailable" };
    case "CLOSED_DATE": return { kind: "rejected", conflict: "closed_date" };
    case "STALE_DATE": return { kind: "rejected", conflict: "date_changed" };
    case "IDEMPOTENCY_CONFLICT": return { kind: "rejected", conflict: "idempotency" };
  }
  if (result.errors.some((error) => error.code === "DUPLICATE_INVOICE" || error.code === "INVOICE_NUMBER_ALREADY_REGISTERED"
    || (INVOICE_FIELDS.has(error.field) && /already exists/i.test(error.message)))) return { kind: "rejected", conflict: "duplicate_invoice" };
  if (result.errors.some((error) => CUSTOMER_FIELDS.has(error.field))) return { kind: "rejected", conflict: "customer" };
  return { kind: "rejected", conflict: "validation" };
}

/**
 * Next queue state after an attempt. `before` is the submission as it was
 * before this attempt was sent. The idempotency key and payload never change.
 */
export function nextSubmission(before: DraftSubmission, outcome: SaveOutcome, message: string): DraftSubmission | null {
  switch (outcome.kind) {
    case "saved":
    case "rejected": return null;
    case "uncertain": return { ...before, status: "uncertain", attempts: before.attempts + 1, lastError: message };
    // A refusal says nothing about an earlier attempt, so earlier uncertainty survives.
    case "blocked": return { ...before, attempts: before.attempts + 1, lastError: message };
  }
}

/** Delay before automatic attempt `attempt` (0-based), or null when the user must retry by hand. */
export function retryDelayMs(attempt: number): number | null {
  return AUTO_RETRY_DELAYS_MS[attempt] ?? null;
}

export type DraftStatusInput = {
  online: boolean; reconnecting: boolean; sending: boolean; hasDraft: boolean; justSaved: boolean; storageAvailable: boolean;
  submission: Pick<DraftSubmission, "status"> | null; conflict: Pick<DraftConflict, "kind"> | null;
};

/** The single short line that tells the user where their draft stands. */
export function draftStatusLabel(input: DraftStatusInput): string {
  if (input.sending) return "Sending to ShopKhata…";
  if (input.reconnecting) return "Reconnecting — checking your session and shop access…";
  if (input.conflict?.kind === "reauth") return "Sign in again — draft saved locally";
  if (input.submission?.status === "uncertain") {
    return input.online ? "Submission status uncertain — retry the same batch" : "Offline — submission status uncertain; retry when you reconnect";
  }
  if (input.conflict && input.conflict.kind !== "unavailable") return "Conflict — not saved to ShopKhata";
  if (input.submission?.status === "queued") {
    return input.online ? "Retry available — not saved to ShopKhata yet" : "Submission pending — will send when you reconnect";
  }
  if (input.hasDraft) {
    if (!input.storageAvailable) return "Draft is not saved on this device";
    return input.online ? "Saved locally" : "Offline — draft saved locally";
  }
  if (input.justSaved) return "Saved to ShopKhata";
  return input.online ? "" : "Offline";
}
