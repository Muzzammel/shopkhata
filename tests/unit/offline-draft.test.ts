import { describe, expect, it } from "vitest";

import type { EntryRow, InvoiceEntryInput } from "@/lib/invoice-entry";
import {
  AUTO_RETRY_DELAYS_MS, DRAFT_SCHEMA_VERSION, classifySaveResult, draftKey, draftStatusLabel, isBlankRows, isStaleDraft, newSubmission,
  nextSubmission, normalizeStoredDraft, restoreBusinessDate, retryDelayMs, serializeDraft, type DraftStatusInput,
} from "@/lib/offline/draft-state";

const userA = "10000000-0000-4000-8000-000000000102";
const userB = "10000000-0000-4000-8000-000000000101";
const shop1 = "10000000-0000-4000-8000-000000000001";
const shop2 = "10000000-0000-4000-8000-000000000002";
const row = (rowId: string, patch: Partial<EntryRow> = {}): EntryRow => ({
  rowId, invoiceId: `INV-${rowId}`, total: "10.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", note: "", ...patch,
});
const payload: InvoiceEntryInput = { shopId: shop1, businessDate: "2026-10-03", isBackdated: false, backdatedReason: "", idempotencyKey: "key-1", rows: [row("a")] };
const base = {
  userId: userA, shopId: shop1, businessDate: "2026-10-03", today: "2026-10-03", backdatedReason: "", rows: [row("a"), row("b")], customers: {},
  idempotencyKey: "key-1", submission: null, conflict: null, createdAt: "2026-10-03T08:00:00.000Z", now: "2026-10-03T08:05:00.000Z",
};

describe("local draft serialization", () => {
  it("round-trips a draft through storage with rows, IDs, key and timestamps intact", () => {
    const stored = serializeDraft({ ...base, submission: newSubmission(payload, "2026-10-03T08:04:00.000Z") });
    const loaded = normalizeStoredDraft(JSON.parse(JSON.stringify(stored)), { userId: userA, shopId: shop1 });
    expect(loaded).toEqual(stored);
    expect(loaded?.rows.map((item) => item.rowId)).toEqual(["a", "b"]);
    expect(loaded?.idempotencyKey).toBe("key-1");
    expect(loaded?.submission).toMatchObject({ type: "invoice_batch", shopId: shop1, idempotencyKey: "key-1", status: "queued", attempts: 0, lastError: null });
    expect(loaded?.createdAt).toBe("2026-10-03T08:00:00.000Z");
    expect(loaded?.updatedAt).toBe("2026-10-03T08:05:00.000Z");
  });

  it("stores only what the draft needs: no customer that is not linked to a row", () => {
    const linked = { id: "c-1", name: "Mary", mobile: null, public_id: "CUS-1" };
    const stored = serializeDraft({
      ...base, rows: [row("a", { customerId: "c-1" }), row("b")],
      customers: { a: linked, b: { ...linked, id: "c-2" }, gone: { ...linked, id: "c-3" } },
    });
    expect(stored.customers).toEqual({ a: linked });
    expect(Object.keys(stored).sort()).toEqual(["backdatedReason", "businessDate", "conflict", "createdAt", "customers", "idempotencyKey", "key", "rows", "savedOn", "schemaVersion", "shopId", "submission", "updatedAt", "userId"]);
  });

  it("treats a single untouched row as no draft", () => {
    expect(isBlankRows([row("a", { invoiceId: "" , total: "" })])).toBe(true);
    expect(isBlankRows([row("a", { invoiceId: "", total: "", note: "x" })])).toBe(false);
    expect(isBlankRows([row("a", { invoiceId: "", total: "" }), row("b", { invoiceId: "", total: "" })])).toBe(false);
  });
});

describe("local draft schema migration", () => {
  it("upgrades an older record that lacks later-added fields", () => {
    const { customers, submission, conflict, backdatedReason, ...older } = serializeDraft(base);
    void customers; void submission; void conflict; void backdatedReason;
    expect(normalizeStoredDraft(older, { userId: userA, shopId: shop1 })).toEqual({ ...older, customers: {}, submission: null, conflict: null, backdatedReason: "" });
  });

  it("ignores a record from a newer schema, a corrupt record and a missing record", () => {
    const stored = serializeDraft(base);
    expect(normalizeStoredDraft({ ...stored, schemaVersion: DRAFT_SCHEMA_VERSION + 1 }, { userId: userA, shopId: shop1 })).toBeNull();
    expect(normalizeStoredDraft({ ...stored, rows: "not rows" }, { userId: userA, shopId: shop1 })).toBeNull();
    expect(normalizeStoredDraft({ ...stored, rows: [] }, { userId: userA, shopId: shop1 })).toBeNull();
    expect(normalizeStoredDraft(undefined, { userId: userA, shopId: shop1 })).toBeNull();
  });

  it("ignores a queued submission whose key or shop does not match its own payload", () => {
    const submission = newSubmission(payload, "2026-10-03T08:04:00.000Z");
    const owner = { userId: userA, shopId: shop1 };
    expect(normalizeStoredDraft(serializeDraft({ ...base, submission: { ...submission, idempotencyKey: "other" } }), owner)).toBeNull();
    expect(normalizeStoredDraft(serializeDraft({ ...base, submission: { ...submission, payload: { ...payload, shopId: shop2 } } }), owner)).toBeNull();
  });
});

describe("user and shop namespacing", () => {
  it("keys every draft by user and shop", () => {
    expect(draftKey(userA, shop1)).toBe(`${userA}:${shop1}`);
    expect(new Set([draftKey(userA, shop1), draftKey(userA, shop2), draftKey(userB, shop1), draftKey(userB, shop2)]).size).toBe(4);
  });

  it("never returns one user's draft to another user or for another shop", () => {
    const stored = serializeDraft(base);
    expect(normalizeStoredDraft(stored, { userId: userB, shopId: shop1 })).toBeNull();
    expect(normalizeStoredDraft(stored, { userId: userA, shopId: shop2 })).toBeNull();
    // A record copied under another user's key is still refused.
    expect(normalizeStoredDraft({ ...stored, key: draftKey(userB, shop1) }, { userId: userB, shopId: shop1 })).toBeNull();
    expect(normalizeStoredDraft(stored, { userId: userA, shopId: shop1 })).not.toBeNull();
  });
});

describe("draft dates and retention", () => {
  it("moves a draft that followed today to the new day but keeps an explicit backdate", () => {
    expect(restoreBusinessDate({ businessDate: "2026-10-03", savedOn: "2026-10-03" }, "2026-10-04")).toBe("2026-10-04");
    expect(restoreBusinessDate({ businessDate: "2026-09-20", savedOn: "2026-10-03" }, "2026-10-04")).toBe("2026-09-20");
    expect(restoreBusinessDate({ businessDate: "2026-10-09", savedOn: "2026-10-03" }, "2026-10-04")).toBe("2026-10-04");
  });

  it("expires only plain drafts, never one whose submission is still in doubt", () => {
    const now = new Date("2026-11-15T00:00:00.000Z");
    expect(isStaleDraft({ updatedAt: "2026-10-03T08:05:00.000Z", submission: null }, now)).toBe(true);
    expect(isStaleDraft({ updatedAt: "2026-11-01T08:05:00.000Z", submission: null }, now)).toBe(false);
    expect(isStaleDraft({ updatedAt: "2026-10-03T08:05:00.000Z", submission: newSubmission(payload, "2026-10-03T08:04:00.000Z") }, now)).toBe(false);
  });
});

describe("conflict mapping", () => {
  const classify = (result: Partial<Parameters<typeof classifySaveResult>[0]>) => classifySaveResult({ ok: false, errors: [], ...result });
  it("maps server results to what they prove about the submission", () => {
    expect(classify({ ok: true })).toEqual({ kind: "saved" });
    expect(classify({ uncertain: true })).toEqual({ kind: "uncertain" });
    expect(classify({ code: "UNAUTHENTICATED" })).toEqual({ kind: "blocked", reason: "reauth" });
    expect(classify({ code: "UNAUTHORIZED_SHOP" })).toEqual({ kind: "blocked", reason: "authorization" });
    expect(classify({ code: "INSUFFICIENT_ROLE" })).toEqual({ kind: "blocked", reason: "authorization" });
    expect(classify({ code: "UNAVAILABLE" })).toEqual({ kind: "blocked", reason: "unavailable" });
    expect(classify({ code: "CLOSED_DATE" })).toEqual({ kind: "rejected", conflict: "closed_date" });
    expect(classify({ code: "STALE_DATE" })).toEqual({ kind: "rejected", conflict: "date_changed" });
    expect(classify({ code: "IDEMPOTENCY_CONFLICT" })).toEqual({ kind: "rejected", conflict: "idempotency" });
  });

  it("identifies a taken invoice number and a customer problem from row errors", () => {
    expect(classify({ code: "VALIDATION", errors: [{ rowId: "a", field: "invoice_number", message: "This invoice number already exists in this shop.", code: "INVOICE_NUMBER_ALREADY_REGISTERED" }] }))
      .toEqual({ kind: "rejected", conflict: "duplicate_invoice" });
    expect(classify({ code: "VALIDATION", errors: [{ rowId: "a", field: "invoiceId", message: "Invoice ID already exists in this shop.", code: "DUPLICATE_INVOICE" }] }))
      .toEqual({ kind: "rejected", conflict: "duplicate_invoice" });
    expect(classify({ code: "VALIDATION", errors: [{ rowId: "a", field: "customer", message: "Customer was not found in this shop.", code: "CUSTOMER_NOT_FOUND" }] }))
      .toEqual({ kind: "rejected", conflict: "customer" });
    expect(classify({ code: "VALIDATION", errors: [{ rowId: "a", field: "total", message: "bad" }] })).toEqual({ kind: "rejected", conflict: "validation" });
  });

  it("treats an uncertain result as uncertain even if it carries a code", () => {
    expect(classify({ uncertain: true, code: "VALIDATION" })).toEqual({ kind: "uncertain" });
  });
});

describe("queue status transitions", () => {
  const queued = newSubmission(payload, "2026-10-03T08:04:00.000Z");
  const uncertain = nextSubmission(queued, { kind: "uncertain" }, "lost")!;

  it("starts queued with the draft's own key and payload", () => {
    expect(queued).toEqual({ type: "invoice_batch", shopId: shop1, idempotencyKey: "key-1", payload, status: "queued", queuedAt: "2026-10-03T08:04:00.000Z", attempts: 0, lastError: null });
  });

  it("becomes uncertain after a lost response and counts the attempt", () => {
    expect(uncertain).toMatchObject({ status: "uncertain", attempts: 1, lastError: "lost" });
  });

  it("never changes the idempotency key or payload across any number of retries", () => {
    let current = queued;
    for (const outcome of [{ kind: "uncertain" }, { kind: "blocked", reason: "reauth" }, { kind: "uncertain" }, { kind: "blocked", reason: "authorization" }] as const) {
      current = nextSubmission(current, outcome, "again")!;
      expect(current.idempotencyKey).toBe("key-1");
      expect(current.payload).toBe(payload);
    }
    expect(current.attempts).toBe(4);
  });

  it("keeps earlier uncertainty when a later retry is refused before the key is evaluated", () => {
    for (const reason of ["reauth", "authorization", "unavailable"] as const) {
      expect(nextSubmission(uncertain, { kind: "blocked", reason }, "refused")).toMatchObject({ status: "uncertain", lastError: "refused" });
      expect(nextSubmission(queued, { kind: "blocked", reason }, "refused")).toMatchObject({ status: "queued" });
    }
  });

  it("keeps the original business date in a submission while the draft's own date moves to the new day", () => {
    // Queued at 23:59 Qatar time, retried after midnight.
    const stored = serializeDraft({ ...base, submission: uncertain });
    const restored = normalizeStoredDraft(JSON.parse(JSON.stringify(stored)), { userId: userA, shopId: shop1 })!;
    expect(restoreBusinessDate(restored, "2026-10-04")).toBe("2026-10-04");
    expect(restored.submission?.payload.businessDate).toBe("2026-10-03");
    expect(restored.submission?.payload.isBackdated).toBe(false);
    expect(restored.submission?.idempotencyKey).toBe("key-1");
    expect(nextSubmission(restored.submission!, { kind: "uncertain" }, "again")?.payload).toEqual(payload);
  });

  it("leaves the queue only on a confirmed commit or a proven rejection", () => {
    expect(nextSubmission(uncertain, { kind: "saved" }, "")).toBeNull();
    expect(nextSubmission(uncertain, { kind: "rejected", conflict: "duplicate_invoice" }, "")).toBeNull();
    expect(nextSubmission(queued, { kind: "rejected", conflict: "closed_date" }, "")).toBeNull();
  });
});

describe("retry backoff", () => {
  it("backs off across a bounded number of automatic attempts, then requires the user", () => {
    expect(AUTO_RETRY_DELAYS_MS).toEqual([1_000, 5_000, 15_000]);
    expect([0, 1, 2].map(retryDelayMs)).toEqual([1_000, 5_000, 15_000]);
    expect(retryDelayMs(3)).toBeNull();
    expect(retryDelayMs(99)).toBeNull();
    expect([...AUTO_RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual([...AUTO_RETRY_DELAYS_MS]);
  });
});

describe("draft status line", () => {
  const idle: DraftStatusInput = { online: true, reconnecting: false, sending: false, hasDraft: false, justSaved: false, storageAvailable: true, submission: null, conflict: null };
  it("distinguishes local, pending, uncertain, conflict and committed states", () => {
    expect(draftStatusLabel(idle)).toBe("");
    expect(draftStatusLabel({ ...idle, online: false })).toBe("Offline");
    expect(draftStatusLabel({ ...idle, hasDraft: true })).toBe("Saved locally");
    expect(draftStatusLabel({ ...idle, hasDraft: true, online: false })).toBe("Offline — draft saved locally");
    expect(draftStatusLabel({ ...idle, hasDraft: true, storageAvailable: false })).toBe("Draft is not saved on this device");
    expect(draftStatusLabel({ ...idle, hasDraft: true, online: false, submission: { status: "queued" } })).toBe("Submission pending — will send when you reconnect");
    expect(draftStatusLabel({ ...idle, hasDraft: true, submission: { status: "queued" } })).toBe("Retry available — not saved to ShopKhata yet");
    expect(draftStatusLabel({ ...idle, hasDraft: true, submission: { status: "queued" }, reconnecting: true })).toBe("Reconnecting — checking your session and shop access…");
    expect(draftStatusLabel({ ...idle, hasDraft: true, submission: { status: "uncertain" } })).toBe("Submission status uncertain — retry the same sale");
    expect(draftStatusLabel({ ...idle, hasDraft: true, conflict: { kind: "duplicate_invoice" } })).toBe("Conflict — not saved to ShopKhata");
    expect(draftStatusLabel({ ...idle, hasDraft: true, submission: { status: "queued" }, conflict: { kind: "reauth" } })).toBe("Sign in again — draft saved locally");
    expect(draftStatusLabel({ ...idle, hasDraft: true, submission: { status: "uncertain" }, conflict: { kind: "reauth" } })).toBe("Sign in again — draft saved locally");
    expect(draftStatusLabel({ ...idle, hasDraft: true, online: false, submission: { status: "uncertain" } })).toBe("Offline — submission status uncertain; retry when you reconnect");
    expect(draftStatusLabel({ ...idle, justSaved: true })).toBe("Saved to ShopKhata");
  });

  it("never reports a draft with an unconfirmed submission as saved to ShopKhata", () => {
    for (const status of ["queued", "uncertain"] as const) for (const online of [true, false]) {
      expect(draftStatusLabel({ ...idle, online, hasDraft: true, justSaved: true, submission: { status } })).not.toContain("Saved to ShopKhata");
    }
  });
});
