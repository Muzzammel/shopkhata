// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { can, type Actor } from "@/lib/auth/permissions";
import { operationError, voidInput, voidReasonError } from "@/lib/invoice-operations";
import type { InvoiceDetail } from "@/lib/invoice-detail";
import { invoiceBadges } from "@/lib/sales-view";

// OPS-01B slice 1. The database rules themselves are proven in supabase/tests/invoice_void.test.sql.

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), rpc: vi.fn(), revalidate: vi.fn(), log: vi.fn(), voidAction: vi.fn(), operation: vi.fn(), refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/server-log", () => ({ logFailure: mocks.log }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/auth/permissions", async (load) => ({ ...(await load<typeof import("@/lib/auth/permissions")>()), getCurrentActor: mocks.actor }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/customer-search", () => ({ CustomerSearch: () => null }));

const SHOP = "10000000-0000-4000-8000-000000000001";
const OTHER_SHOP = "10000000-0000-4000-8000-000000000002";
const INVOICE = "a9000000-0000-4000-8000-000000000001";
const KEY = "10000000-0000-4000-8000-000000000009";
const command = { shop_id: SHOP, invoice_id: INVOICE, idempotency_key: KEY, reason: "  Customer cancelled the order  " };
const actor = (role: Actor["role"], extra: Partial<Actor> = {}): Actor => ({ id: `${role}-id`, role, isActive: true, shopIds: [SHOP], ...extra });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("void reason rule", () => {
  it("trims, requires at least 10 and at most 2000 characters, and rejects whitespace-only reasons", () => {
    expect(voidInput.parse(command).reason).toBe("Customer cancelled the order");
    expect(voidReasonError("")).toBe("REASON_REQUIRED");
    expect(voidReasonError(" \t\n  ")).toBe("REASON_REQUIRED");
    expect(voidReasonError("  too short ")).toBe("REASON_TOO_SHORT");
    expect(voidReasonError("1234567890")).toBeNull();
    expect(voidReasonError("x".repeat(2000))).toBeNull();
    expect(voidReasonError("x".repeat(2001))).toBe("INVALID_REQUEST");
    for (const reason of ["", "   ", "short", "x".repeat(2001)]) expect(voidInput.safeParse({ ...command, reason }).success).toBe(false);
  });
  it("accepts only the four command fields with UUID ids", () => {
    expect(voidInput.safeParse({ ...command, amount_delta_dirham: -1 }).success).toBe(false);
    expect(voidInput.safeParse({ ...command, actor: "x" }).success).toBe(false);
    expect(voidInput.safeParse({ ...command, invoice_id: "not-a-uuid" }).success).toBe(false);
    expect(voidInput.safeParse({ ...command, idempotency_key: undefined }).success).toBe(false);
  });
  it("maps every void refusal to a fixed message", () => {
    for (const code of ["PAYMENTS_OUTSTANDING", "CREDIT_APPLIED", "ALREADY_VOID", "INVOICE_VOID", "REASON_REQUIRED", "REASON_TOO_SHORT", "CLOSED_DATE", "SHOP_INACTIVE", "INSUFFICIENT_ROLE"]) {
      expect(operationError(code), code).not.toBe("The operation could not be completed.");
    }
    expect(operationError("PAYMENTS_OUTSTANDING")).toContain("Reverse the payments");
    expect(operationError('duplicate key value violates unique constraint "invoice_voids_invoice_id_key"')).toBe("The operation could not be completed.");
  });
});

describe("invoice.void permission", () => {
  it("is granted to owner and an assigned manager, never to staff", () => {
    expect(can(actor("owner", { shopIds: [] }), "invoice.void", SHOP)).toBe(true);
    expect(can(actor("manager"), "invoice.void", SHOP)).toBe(true);
    expect(can(actor("staff"), "invoice.void", SHOP)).toBe(false);
  });
  it("still requires shop assignment, a shop id and an active account", () => {
    expect(can(actor("manager"), "invoice.void", OTHER_SHOP)).toBe(false);
    expect(can(actor("manager"), "invoice.void")).toBe(false);
    expect(can(actor("owner", { isActive: false }), "invoice.void", SHOP)).toBe(false);
  });
  it("shows VOID instead of paid/corrected", () => {
    expect(invoiceBadges({ dueDirham: 0, delivered: true, corrected: true, revision: 1, isVoid: true })).toEqual(["void", "delivered", "replaced"]);
    expect(invoiceBadges({ dueDirham: 0, delivered: false, corrected: false, revision: 0 })).toEqual(["paid"]);
  });
});

describe("invoice export Status and Original Total columns", () => {
  it("labels the current-state total, keeps Status, and never exports a voided invoice's original amount as 0", async () => {
    const { INVOICE_EXPORT_HEADERS, invoiceExportSheet } = await import("@/lib/excel/exports");
    expect(INVOICE_EXPORT_HEADERS).toEqual(["Invoice Number", "Business Date", "Current Total QAR", "Paid QAR", "Credit Applied QAR", "Due QAR", "Delivered", "Customer", "Customer Mobile", "Recorded At (Qatar)", "Original Number", "Invoice Reference", "Status", "Original Total QAR"]);
    const row = { invoiceNumber: "V-1", businessDate: "2026-10-03", totalDirham: 0, paidDirham: 0, creditAppliedDirham: 0, dueDirham: 0, delivered: false, customerName: "", customerMobile: "", recordedAt: null, originalNumber: "V-1", invoiceId: INVOICE, originalTotalDirham: 10000 };
    const sheet = invoiceExportSheet([{ ...row, isVoid: true }, { ...row, invoiceNumber: "A-1", isVoid: false }]);
    expect(sheet.data.map((cells) => cells.at(-2))).toEqual([{ value: "Status", fontWeight: "bold" }, "VOID", "ACTIVE"]);
    expect(sheet.data[1].at(-1)).toEqual({ value: 100, type: Number, format: "0.00" });
    expect(sheet.data[1]).toHaveLength(14);
  });
});

describe("void reason counts Unicode characters, as PostgreSQL length() does", () => {
  it("accepts 2000 emoji (4000 UTF-16 units) and refuses 2001; 10 emoji meet the minimum", () => {
    expect(voidReasonError("😀".repeat(2000))).toBeNull();
    expect(voidReasonError("😀".repeat(2001))).toBe("INVALID_REQUEST");
    expect(voidReasonError("😀".repeat(9))).toBe("REASON_TOO_SHORT");
    expect(voidReasonError("😀".repeat(10))).toBeNull();
    expect(voidInput.safeParse({ ...command, reason: "😀".repeat(2000) }).success).toBe(true);
    expect(voidInput.safeParse({ ...command, reason: "😀".repeat(2001) }).success).toBe(false);
  });
});

describe("New Sale recent-invoice preview (m1)", () => {
  it("keeps is_void, so a voided invoice (due 0) shows VOID and never Paid", async () => {
    const { workspaceInvoice } = await import("@/lib/shop-workspace");
    const row = { canonical_invoice_id: INVOICE, effective_invoice_number: "V-1", business_date: "2026-11-01", effective_total_dirham: 0, effective_due_dirham: 0, effective_delivered: false, effective_customer_id: null };
    const voided = workspaceInvoice({ ...row, is_void: true });
    expect(voided.is_void).toBe(true);
    const badges = invoiceBadges({ dueDirham: voided.effective_due_dirham, delivered: voided.delivered, corrected: false, revision: 0, isVoid: voided.is_void });
    expect(badges).toContain("void");
    expect(badges).not.toContain("paid");
    expect(workspaceInvoice({ ...row, is_void: false }).is_void).toBe(false);
  });
});

describe("voidInvoice server action", () => {
  const load = async () => (await vi.importActual<typeof import("@/app/(app)/invoice-operation-actions")>("@/app/(app)/invoice-operation-actions")).voidInvoice;
  beforeEach(() => { mocks.actor.mockResolvedValue(actor("manager")); });

  it("validates before authenticating and never calls the database for an invalid reason", async () => {
    const voidInvoice = await load();
    expect(await voidInvoice({ ...command, reason: "   " })).toMatchObject({ ok: false, uncertain: false, code: "REASON_REQUIRED" });
    expect(await voidInvoice({ ...command, reason: "short" })).toMatchObject({ ok: false, uncertain: false, code: "REASON_TOO_SHORT" });
    expect(await voidInvoice({ ...command, invoice_id: "x" })).toMatchObject({ ok: false, uncertain: false, code: "INVALID_REQUEST" });
    expect(await voidInvoice(null)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses staff and unassigned managers with can() before the RPC", async () => {
    const voidInvoice = await load();
    mocks.actor.mockResolvedValueOnce(actor("staff"));
    expect(await voidInvoice(command)).toMatchObject({ ok: false, uncertain: false, code: "INSUFFICIENT_ROLE" });
    mocks.actor.mockResolvedValueOnce(actor("manager", { shopIds: [OTHER_SHOP] }));
    expect(await voidInvoice(command)).toMatchObject({ ok: false, uncertain: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sends the trimmed command and accepts only a matching receipt", async () => {
    const voidInvoice = await load();
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, invoice_id: INVOICE, void_id: "v1", correction_id: "c1", business_date: "2026-11-03" }, error: null });
    expect(await voidInvoice(command)).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("void_invoice", { command: { ...command, reason: "Customer cancelled the order" } });
    expect(mocks.revalidate).toHaveBeenCalledWith(`/shops/${SHOP}/invoices/${INVOICE}`);
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, invoice_id: "someone-else", void_id: "v1" }, error: null });
    expect(await voidInvoice(command)).toMatchObject({ ok: false, uncertain: true });
  });

  it("maps domain errors to fixed messages and never leaks database text", async () => {
    const voidInvoice = await load();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "PAYMENTS_OUTSTANDING" } });
    expect(await voidInvoice(command)).toEqual({ ok: false, uncertain: false, code: "PAYMENTS_OUTSTANDING", message: operationError("PAYMENTS_OUTSTANDING") });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "invoice_voids_invoice_id_key"' } });
    const leaked = await voidInvoice(command);
    expect(leaked).toEqual({ ok: false, uncertain: false, code: undefined, message: "The operation could not be completed." });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "fetch failed" } });
    expect(await voidInvoice(command)).toMatchObject({ ok: false, uncertain: true });
  });
});

describe("void action in the invoice operations UI", () => {
  const detail: InvoiceDetail = {
    id: INVOICE, shopId: SHOP, invoiceNumber: "INV-77", originalInvoiceNumber: "INV-77", originalCustomerId: null, originalDelivered: false, revision: 0, changes: [],
    originalTotalDirham: 12000, effectiveTotalDirham: 10000, effectivePaidDirham: 0, effectiveCreditAppliedDirham: 0, effectiveDueDirham: 10000,
    businessDate: "2026-10-03", recordedAt: "2026-10-03T00:00:00Z", createdBy: null, creatorName: null, delivered: false, customer: null, payments: [], corrections: [],
    voided: null, people: {}, customerNames: {},
  };
  const permissions = { payment: true, requestCorrection: true, requestReplacement: true, approveCorrection: true, approveReplacement: true, voidInvoice: true };
  const renderOps = async (props: { detail?: InvoiceDetail; permissions?: typeof permissions } = {}) => {
    vi.doMock("@/app/(app)/invoice-operation-actions", () => ({ runInvoiceOperation: mocks.operation, voidInvoice: mocks.voidAction }));
    const { InvoiceOperations } = await import("@/app/(app)/invoice-operations");
    render(createElement(InvoiceOperations, { detail: props.detail ?? detail, permissions: props.permissions ?? permissions }));
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
  };

  it("offers Void invoice only with invoice.void on an invoice that is not void", async () => {
    await renderOps();
    expect(await screen.findByRole("menuitem", { name: "Void invoice" })).toBeTruthy();
    cleanup();
    await renderOps({ permissions: { ...permissions, voidInvoice: false } });
    await screen.findByRole("menuitem", { name: "Print" });
    expect(screen.queryByRole("menuitem", { name: "Void invoice" })).toBeNull();
    cleanup();
    await renderOps({ detail: { ...detail, effectiveTotalDirham: 0, effectiveDueDirham: 0, voided: { id: "v", reason: "Customer cancelled", businessDate: "2026-11-03", actorId: "m", createdAt: "2026-11-03T08:00:00Z", correctionId: "c" } } });
    await screen.findByRole("menuitem", { name: "Print" });
    expect(screen.queryByRole("menuitem", { name: "Void invoice" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Request replacement" })).toBeNull();
  });

  it("confirms with the invoice's number and totals, requires a real reason, and sends it trimmed", async () => {
    mocks.voidAction.mockResolvedValueOnce({ ok: true });
    await renderOps();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Void invoice" }));
    const dialog = await screen.findByRole("dialog", { name: "Void invoice INV-77" });
    const facts = Object.fromEntries([...within(dialog).getByLabelText("Invoice to void").querySelectorAll("div")].map((item) => [item.querySelector("dt")!.textContent, item.querySelector("dd")!.textContent]));
    expect(facts).toMatchObject({ "Invoice number": "INV-77", "Original total": "QAR 120.00", "Effective total": "QAR 100.00", "Effective total after void": "QAR 0.00" });
    expect(within(dialog).getByText(/original invoice is preserved unchanged/)).toBeTruthy();
    const reason = within(dialog).getByLabelText(/Reason for voiding/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Void" }));
    expect(await within(dialog).findByText(operationError("REASON_REQUIRED"))).toBeTruthy();
    fireEvent.change(reason, { target: { value: "  too short  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Void" }));
    expect(await within(dialog).findByText(operationError("REASON_TOO_SHORT"))).toBeTruthy();
    expect(mocks.voidAction).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: "  Customer cancelled the order  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Void" }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Invoice voided."));
    expect(mocks.voidAction).toHaveBeenCalledWith(expect.objectContaining({ shop_id: SHOP, invoice_id: INVOICE, reason: "Customer cancelled the order" }));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("disables Confirm Void and says why when the invoice has payments", async () => {
    await renderOps({ detail: { ...detail, effectivePaidDirham: 2000, effectiveDueDirham: 8000 } });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Void invoice" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(operationError("PAYMENTS_OUTSTANDING"))).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Confirm Void" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
