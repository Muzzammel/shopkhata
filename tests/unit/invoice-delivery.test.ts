// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InvoiceDelivery } from "@/app/(app)/invoice-delivery";
import { InvoiceOperations } from "@/app/(app)/invoice-operations";
import { can, type Actor } from "@/lib/auth/permissions";
import { deliveryBlockReason, deliveryError, deliveryInput, orderCorrectionBlockReason, orderCorrectionInput, parseDeliveryPieces, parseOrderedPieces, reversalBlockReason, reversalInput, reversibleDeliveryIds, summarizeDeliveries, type DeliveryEvent, type OrderCorrection } from "@/lib/invoice-delivery";
import type { InvoiceDetail } from "@/lib/invoice-detail";

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), reverse: vi.fn(), correct: vi.fn(), refresh: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/app/(app)/invoice-operation-actions", () => ({ recordInvoiceDelivery: mocks.deliver, reverseInvoiceDelivery: mocks.reverse, correctOrderedPieces: mocks.correct, runInvoiceOperation: vi.fn(), voidInvoice: vi.fn() }));
vi.mock("@/app/(app)/payment-actions", () => ({ recordInvoicePayment: vi.fn(), lookupInvoiceForPayment: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/customer-search", () => ({ CustomerSearch: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const shopId = "10000000-0000-4000-8000-000000000001";
const invoiceId = "a9000000-0000-4000-8000-000000000001";
const event = (pieces: number, withSale = false): DeliveryEvent => ({ id: crypto.randomUUID(), pieces, businessDate: "2026-11-12", recordedAt: "2026-11-12T08:00:00Z", createdBy: "u1", withSale });

describe("delivery ledger helpers", () => {
  it("derives totals and status from the events only", () => {
    expect(summarizeDeliveries(100, [])).toMatchObject({ delivered: 0, remaining: 100, status: "none" });
    expect(summarizeDeliveries(100, [event(60, true)])).toMatchObject({ delivered: 60, remaining: 40, status: "partial" });
    expect(summarizeDeliveries(100, [event(60, true), event(40)])).toMatchObject({ delivered: 100, remaining: 0, status: "full" });
  });

  it("accepts only positive whole pieces up to the remaining count", () => {
    expect(parseDeliveryPieces("40", 40)).toEqual({ pieces: 40 });
    for (const bad of ["0", "", "1.5", "-1", "2e1", "abc"]) expect(parseDeliveryPieces(bad, 40)).toEqual({ error: "Enter a whole number of pieces, at least 1." });
    expect(parseDeliveryPieces("41", 40)).toEqual({ error: "Only 40 pieces remain to deliver." });
    expect(deliveryInput.safeParse({ shop_id: shopId, invoice_id: invoiceId, pieces: 1.5, idempotency_key: crypto.randomUUID() }).success).toBe(false);
    expect(deliveryInput.safeParse({ shop_id: shopId, invoice_id: invoiceId, pieces: 0, idempotency_key: crypto.randomUUID() }).success).toBe(false);
  });

  it("blocks recording for each refused state", () => {
    const pieces = summarizeDeliveries(10, [event(4)]);
    const ok = { pieces, isVoid: false, shopActive: true, todayClosed: false, canRecord: true };
    expect(deliveryBlockReason(ok)).toBeNull();
    expect(deliveryBlockReason({ ...ok, canRecord: false })).toMatch(/cannot record/);
    expect(deliveryBlockReason({ ...ok, pieces: null })).toMatch(/without piece counts/);
    expect(deliveryBlockReason({ ...ok, isVoid: true })).toMatch(/void/);
    expect(deliveryBlockReason({ ...ok, shopActive: false })).toMatch(/inactive/);
    expect(deliveryBlockReason({ ...ok, todayClosed: true })).toMatch(/closed/);
    expect(deliveryBlockReason({ ...ok, pieces: summarizeDeliveries(10, [event(10)]) })).toMatch(/All ordered pieces/);
  });
});

describe("Record delivery", () => {
  const view = (blockedReason: string | null = null) => render(createElement(InvoiceDelivery, {
    shopId, invoiceId, invoiceReference: "INV-9", pieces: summarizeDeliveries(100, [event(60, true)]), people: { u1: "Staff One" }, blockedReason,
  }));
  const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Record delivery" }));

  it("shows the ledger figures and history", () => {
    view();
    expect(screen.getByLabelText("Piece delivery").textContent).toBe("Ordered pieces100Delivered pieces60Remaining pieces40Delivery statusPartially delivered");
    expect(screen.getByRole("list", { name: "Delivery history" }).textContent).toContain("With the sale");
    expect(screen.getByRole("list", { name: "Delivery history" }).textContent).toContain("by Staff One · invoice INV-9");
  });

  it("rejects over-delivery before sending", () => {
    view();
    fireEvent.change(screen.getByLabelText("Pieces delivered now"), { target: { value: "41" } });
    submit();
    expect(screen.getByText("Only 40 pieces remain to deliver.")).toBeTruthy();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("retries an uncertain delivery with the same key and payload, and sends nothing twice while pending", async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.deliver.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce({ ok: true });
    view();
    fireEvent.change(screen.getByLabelText("Pieces delivered now"), { target: { value: "40" } });
    submit(); submit();
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: false, uncertain: true, message: "Status is uncertain. Retry the exact delivery." });
    const retry = await screen.findByRole("button", { name: "Retry exact delivery" });
    expect((screen.getByLabelText("Pieces delivered now") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.deliver).toHaveBeenCalledTimes(2);
    expect(mocks.deliver.mock.calls[1][0]).toEqual(mocks.deliver.mock.calls[0][0]);
    expect(mocks.deliver.mock.calls[0][0]).toMatchObject({ shop_id: shopId, invoice_id: invoiceId, pieces: 40 });
  });

  it("uses a new key after a definite refusal", async () => {
    mocks.deliver.mockResolvedValueOnce({ ok: false, uncertain: false, message: "Over", code: "OVER_DELIVERY" }).mockResolvedValueOnce({ ok: true });
    view();
    fireEvent.change(screen.getByLabelText("Pieces delivered now"), { target: { value: "10" } });
    submit();
    await screen.findByText("Over");
    submit();
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(2));
    expect(mocks.deliver.mock.calls[1][0].idempotency_key).not.toBe(mocks.deliver.mock.calls[0][0].idempotency_key);
  });

  it("offers no action when blocked", () => {
    view("Today's business date is closed. Deliveries cannot be recorded until it is reopened.");
    expect(screen.queryByRole("button", { name: "Record delivery" })).toBeNull();
    expect(screen.getByText(/business date is closed/)).toBeTruthy();
  });
});

describe("invoice operations for piece-tracked invoices", () => {
  const detail: InvoiceDetail = {
    id: invoiceId, shopId, invoiceNumber: "INV-9", originalInvoiceNumber: "INV-9", originalCustomerId: null, originalDelivered: false, revision: 0, changes: [],
    originalTotalDirham: 10000, effectiveTotalDirham: 10000, effectivePaidDirham: 10000, effectiveCreditAppliedDirham: 0, effectiveDueDirham: 0,
    businessDate: "2026-11-12", recordedAt: "2026-11-12T00:00:00Z", createdBy: null, creatorName: null, delivered: true, pieces: summarizeDeliveries(100, [event(60, true)]),
    customer: null, payments: [], corrections: [], voided: null, people: {}, customerNames: {},
  };
  const permissions = { payment: true, requestCorrection: true, requestReplacement: true, approveCorrection: false, approveReplacement: false };

  it("hides Request delivery change for tracked invoices and keeps it for legacy ones", () => {
    const tracked = render(createElement(InvoiceOperations, { detail, permissions }));
    expect(screen.queryByRole("button", { name: "Request delivery change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Request correction" })).toBeTruthy();
    tracked.unmount();
    render(createElement(InvoiceOperations, { detail: { ...detail, pieces: null }, permissions }));
    expect(screen.getByRole("button", { name: "Request delivery change" })).toBeTruthy();
  });
});

// Step 6A. The database rules themselves are proven in supabase/tests/delivery_reversal.test.sql.
describe("delivery reversal helpers", () => {
  const first = event(60, true); const second = event(40);
  const reversal: DeliveryEvent = { ...event(-60), reversesId: first.id, reason: "Delivered to the wrong customer" };

  it("nets reversals out of the delivered total and status", () => {
    expect(summarizeDeliveries(100, [first, second])).toMatchObject({ delivered: 100, remaining: 0, status: "full" });
    expect(summarizeDeliveries(100, [first, second, reversal])).toMatchObject({ delivered: 40, remaining: 60, status: "partial" });
    expect(summarizeDeliveries(100, [first, reversal])).toMatchObject({ delivered: 0, remaining: 100, status: "none" });
  });

  it("offers each delivery once: never a reversed delivery, never a reversal", () => {
    expect([...reversibleDeliveryIds([first, second])].sort()).toEqual([first.id, second.id].sort());
    expect([...reversibleDeliveryIds([first, second, reversal])]).toEqual([second.id]);
  });

  it("requires a whole command with a reason of 10 to 2000 characters and no pieces", () => {
    const command = { shop_id: shopId, invoice_id: invoiceId, delivery_id: first.id, idempotency_key: crypto.randomUUID(), reason: "  Delivered to the wrong customer  " };
    expect(reversalInput.parse(command).reason).toBe("Delivered to the wrong customer");
    for (const reason of ["", "   ", "too short", "x".repeat(2001)]) expect(reversalInput.safeParse({ ...command, reason }).success).toBe(false);
    expect(reversalInput.safeParse({ ...command, pieces: 30 }).success).toBe(false);
    expect(reversalInput.safeParse({ ...command, delivery_id: "nope" }).success).toBe(false);
  });

  it("blocks reversal for each refused state and explains database refusals", () => {
    const ok = { isVoid: false, shopActive: true, todayClosed: false, canReverse: true };
    expect(reversalBlockReason(ok)).toBeNull();
    expect(reversalBlockReason({ ...ok, canReverse: false })).toMatch(/manager or owner/);
    expect(reversalBlockReason({ ...ok, isVoid: true })).toMatch(/void/);
    expect(reversalBlockReason({ ...ok, shopActive: false })).toMatch(/inactive/);
    expect(reversalBlockReason({ ...ok, todayClosed: true })).toMatch(/closed/);
    expect(deliveryError("ALREADY_REVERSED")).toMatch(/already reversed/);
    expect(deliveryError("INSUFFICIENT_ROLE")).toMatch(/manager or owner/);
    expect(deliveryError("REASON_TOO_SHORT")).toMatch(/at least 10/);
  });

  it("grants delivery.reverse to owner and manager only, within their shops", () => {
    const actor = (role: Actor["role"], shopIds: string[]): Actor => ({ id: "u", role, isActive: true, shopIds });
    expect(can(actor("owner", []), "delivery.reverse", shopId)).toBe(true);
    expect(can(actor("manager", [shopId]), "delivery.reverse", shopId)).toBe(true);
    expect(can(actor("manager", ["10000000-0000-4000-8000-000000000002"]), "delivery.reverse", shopId)).toBe(false);
    expect(can(actor("staff", [shopId]), "delivery.reverse", shopId)).toBe(false);
  });
});

describe("Reverse delivery", () => {
  const first = event(60, true); const second = event(40);
  const reversal: DeliveryEvent = { ...event(-60), reversesId: first.id, reason: "Delivered to the wrong customer", createdBy: "u2" };
  const view = (props: { canReverse?: boolean; reverseBlockedReason?: string | null; events?: DeliveryEvent[] } = {}) => render(createElement(InvoiceDelivery, {
    shopId, invoiceId, invoiceReference: "INV-9", pieces: summarizeDeliveries(100, props.events ?? [first, second]), people: { u1: "Staff One", u2: "Manager One" },
    blockedReason: null, canReverse: props.canReverse ?? true, reverseBlockedReason: props.reverseBlockedReason ?? null,
  }));
  const open = (index = 0) => fireEvent.click(screen.getAllByRole("button", { name: /^Reverse delivery of/ })[index]);
  const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Reverse delivery" }));
  const type = (value: string) => fireEvent.change(screen.getByLabelText("Reason for reversing this delivery"), { target: { value } });

  it("offers no reversal to staff, or when the invoice state blocks it", () => {
    const staff = view({ canReverse: false });
    expect(screen.queryByRole("button", { name: /^Reverse delivery of/ })).toBeNull();
    staff.unmount();
    view({ reverseBlockedReason: "This invoice is void. Deliveries cannot be reversed." });
    expect(screen.queryByRole("button", { name: /^Reverse delivery of/ })).toBeNull();
    expect(screen.getByText("This invoice is void. Deliveries cannot be reversed.")).toBeTruthy();
  });

  it("requires a reason before sending, then sends the whole selected delivery", async () => {
    mocks.reverse.mockResolvedValueOnce({ ok: true });
    view();
    open(1);
    submit();
    expect(screen.getByText("Enter the reason for reversing this delivery.")).toBeTruthy();
    type("too short"); submit();
    expect(screen.getByText("Explain the reversal in at least 10 characters.")).toBeTruthy();
    expect(mocks.reverse).not.toHaveBeenCalled();
    type("  Delivered to the wrong customer "); submit();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.reverse).toHaveBeenCalledTimes(1);
    expect(mocks.reverse.mock.calls[0][0]).toMatchObject({ shop_id: shopId, invoice_id: invoiceId, delivery_id: second.id, reason: "Delivered to the wrong customer" });
    expect(Object.keys(mocks.reverse.mock.calls[0][0]).sort()).toEqual(["delivery_id", "idempotency_key", "invoice_id", "reason", "shop_id"]);
  });

  it("retries an uncertain reversal with the same key and payload, and sends nothing twice while pending", async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.reverse.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce({ ok: true });
    view();
    open(); type("Delivered to the wrong customer");
    submit(); submit();
    expect(mocks.reverse).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: false, uncertain: true, message: "Status is uncertain. Retry the exact reversal." });
    const retry = await screen.findByRole("button", { name: "Retry exact reversal" });
    expect((screen.getByLabelText("Reason for reversing this delivery") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.reverse).toHaveBeenCalledTimes(2);
    expect(mocks.reverse.mock.calls[1][0]).toEqual(mocks.reverse.mock.calls[0][0]);
  });

  it("shows the reversal in history with reason, actor, date and the original delivery; the original stays, marked Reversed", () => {
    view({ events: [first, second, reversal] });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("With the sale · Reversed");
    expect(rows[0].textContent).toContain("60 pieces");
    expect(rows[2].textContent).toContain("Reversal of the 60 pieces delivered on");
    expect(rows[2].textContent).toContain("reason: Delivered to the wrong customer");
    expect(rows[2].textContent).toContain("by Manager One");
    expect(rows[2].textContent).toContain("\u221260 pieces");
    expect(screen.getByLabelText("Piece delivery").textContent).toBe("Ordered pieces100Delivered pieces40Remaining pieces60Delivery statusPartially delivered");
    // Only the 40-piece delivery is still reversible.
    expect(screen.getAllByRole("button", { name: /^Reverse delivery of/ })).toHaveLength(1);
  });
});

describe("Ordered-piece corrections", () => {
  const fix = (before: number, after: number): OrderCorrection => ({
    id: crypto.randomUUID(), before, after, reason: "Customer changed the order", businessDate: "2026-11-12", recordedAt: "2026-11-12T09:00:00Z", createdBy: "u2",
  });
  const base = { shop_id: shopId, invoice_id: invoiceId, expected_ordered_pieces: 10, ordered_pieces: 12, reason: "Customer added two pieces", idempotency_key: crypto.randomUUID() };

  it("uses the latest correction as the ordered quantity and keeps the original", () => {
    expect(summarizeDeliveries(10, [event(4)], [fix(10, 12)])).toMatchObject({ ordered: 12, originalOrdered: 10, delivered: 4, remaining: 8, status: "partial" });
    expect(summarizeDeliveries(10, [event(4)], [fix(10, 12), fix(12, 4)])).toMatchObject({ ordered: 4, originalOrdered: 10, remaining: 0, status: "full" });
    expect(summarizeDeliveries(10, [event(4)])).toMatchObject({ ordered: 10, originalOrdered: 10, corrections: [] });
  });

  it("validates the typed quantity against the current and delivered pieces", () => {
    const pieces = { ordered: 10, delivered: 4 };
    expect(parseOrderedPieces(" 12 ", pieces)).toEqual({ pieces: 12 });
    expect(parseOrderedPieces("4", pieces)).toEqual({ pieces: 4 });
    for (const bad of ["", "0", "-1", "1.5", "2e1", "abc", "2147483648"]) expect(parseOrderedPieces(bad, pieces)).toEqual({ error: "Enter a whole number of pieces, at least 1." });
    expect(parseOrderedPieces("10", pieces)).toEqual({ error: "The invoice already has 10 ordered pieces." });
    expect(parseOrderedPieces("3", pieces)).toEqual({ error: "4 pieces are already delivered. Reverse a delivery first to go lower." });
  });

  it("accepts only the exact command shape", () => {
    expect(orderCorrectionInput.safeParse(base).success).toBe(true);
    expect(orderCorrectionInput.safeParse({ ...base, ordered_pieces: 0 }).success).toBe(false);
    expect(orderCorrectionInput.safeParse({ ...base, ordered_pieces: 1.5 }).success).toBe(false);
    expect(orderCorrectionInput.safeParse({ ...base, reason: "short" }).success).toBe(false);
    expect(orderCorrectionInput.safeParse({ ...base, business_date: "2026-11-11" }).success).toBe(false);
  });

  it("blocks staff, void, inactive shop and closed date in that order", () => {
    const ok = { isVoid: false, shopActive: true, todayClosed: false, canCorrect: true };
    expect(orderCorrectionBlockReason(ok)).toBeNull();
    expect(orderCorrectionBlockReason({ ...ok, canCorrect: false, isVoid: true })).toMatch(/manager or owner/);
    expect(orderCorrectionBlockReason({ ...ok, isVoid: true })).toMatch(/void/);
    expect(orderCorrectionBlockReason({ ...ok, shopActive: false })).toMatch(/inactive/);
    expect(orderCorrectionBlockReason({ ...ok, todayClosed: true })).toMatch(/closed/);
  });

  it("grants delivery.correct_ordered to owner and manager only, within their shops", () => {
    const actor = (role: Actor["role"], shopIds: string[]): Actor => ({ id: "u", role, isActive: true, shopIds });
    expect(can(actor("owner", []), "delivery.correct_ordered", shopId)).toBe(true);
    expect(can(actor("manager", [shopId]), "delivery.correct_ordered", shopId)).toBe(true);
    expect(can(actor("manager", ["10000000-0000-4000-8000-000000000002"]), "delivery.correct_ordered", shopId)).toBe(false);
    expect(can(actor("staff", [shopId]), "delivery.correct_ordered", shopId)).toBe(false);
  });

  const view = (props: { canCorrect?: boolean; correctBlockedReason?: string | null; corrections?: OrderCorrection[] } = {}) => render(createElement(InvoiceDelivery, {
    shopId, invoiceId, invoiceReference: "INV-9", pieces: summarizeDeliveries(10, [event(4)], props.corrections ?? []), people: { u1: "Staff One", u2: "Manager One" },
    blockedReason: null, canCorrect: props.canCorrect ?? true, correctBlockedReason: props.correctBlockedReason ?? null,
  }));
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Correct ordered pieces" }));
  const fill = (pieces: string, reason: string) => {
    fireEvent.change(screen.getByLabelText("Corrected ordered pieces"), { target: { value: pieces } });
    fireEvent.change(screen.getByLabelText("Reason for the correction"), { target: { value: reason } });
  };
  const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Correct ordered pieces" }));

  it("offers no correction to staff, and shows the block reason to a manager", () => {
    const staff = view({ canCorrect: false });
    expect(screen.queryByRole("button", { name: "Correct ordered pieces" })).toBeNull();
    expect(screen.queryByText("Ordered piece corrections")).toBeNull();
    staff.unmount();
    view({ correctBlockedReason: "This invoice is void. Ordered pieces cannot be corrected." });
    expect(screen.queryByRole("button", { name: "Correct ordered pieces" })).toBeNull();
    expect(screen.getByText("This invoice is void. Ordered pieces cannot be corrected.")).toBeTruthy();
  });

  it("validates before sending, then sends the expected and new quantity with a trimmed reason", async () => {
    mocks.correct.mockResolvedValueOnce({ ok: true });
    view();
    open();
    fill("3", "short"); submit();
    expect(screen.getByText("4 pieces are already delivered. Reverse a delivery first to go lower.")).toBeTruthy();
    expect(screen.getByText("Explain the correction in at least 10 characters.")).toBeTruthy();
    expect(mocks.correct).not.toHaveBeenCalled();
    fill("12", "  Customer added two pieces "); submit();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.correct).toHaveBeenCalledTimes(1);
    expect(mocks.correct.mock.calls[0][0]).toMatchObject({ shop_id: shopId, invoice_id: invoiceId, expected_ordered_pieces: 10, ordered_pieces: 12, reason: "Customer added two pieces" });
    expect(Object.keys(mocks.correct.mock.calls[0][0]).sort()).toEqual(["expected_ordered_pieces", "idempotency_key", "invoice_id", "ordered_pieces", "reason", "shop_id"]);
  });

  it("retries an uncertain correction with the exact same command", async () => {
    mocks.correct.mockResolvedValueOnce({ ok: false, uncertain: true, message: "Status is uncertain. Retry the exact correction." }).mockResolvedValueOnce({ ok: true });
    view();
    open(); fill("12", "Customer added two pieces"); submit();
    const retry = await screen.findByRole("button", { name: "Retry exact correction" });
    expect((screen.getByLabelText("Corrected ordered pieces") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.correct).toHaveBeenCalledTimes(2);
    expect(mocks.correct.mock.calls[1][0]).toEqual(mocks.correct.mock.calls[0][0]);
  });

  it("refreshes on a stale quantity", async () => {
    mocks.correct.mockResolvedValueOnce({ ok: false, uncertain: false, code: "STALE_ORDERED_PIECES", message: deliveryError("STALE_ORDERED_PIECES") });
    view();
    open(); fill("12", "Customer added two pieces"); submit();
    expect(await screen.findByText(/changed by someone else/)).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows the history with before/after, reason and actor, and the original quantity", () => {
    view({ corrections: [fix(10, 12)], canCorrect: false });
    const row = screen.getByRole("list", { name: "Ordered piece corrections" }).querySelector("li")!;
    expect(row.textContent).toContain("10 → 12");
    expect(row.textContent).toContain("Reason: Customer changed the order");
    expect(row.textContent).toContain("by Manager One");
    expect(screen.getByLabelText("Piece delivery").textContent).toBe("Ordered pieces12Delivered pieces4Remaining pieces8Delivery statusPartially delivered");
    expect(screen.getByText("Originally ordered 10 pieces.")).toBeTruthy();
  });
});
