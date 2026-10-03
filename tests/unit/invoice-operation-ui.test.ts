// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InvoicePayment } from "@/app/(app)/invoice-payment";
import { InvoiceOperations } from "@/app/(app)/invoice-operations";
import type { InvoiceDetail } from "@/lib/invoice-detail";

const mocks = vi.hoisted(() => ({ payment: vi.fn(), operation: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/(app)/payment-actions", () => ({ recordInvoicePayment: mocks.payment, lookupInvoiceForPayment: vi.fn() }));
vi.mock("@/app/(app)/invoice-operation-actions", () => ({ runInvoiceOperation: mocks.operation }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/customer-search", () => ({ CustomerSearch: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const id = "a9000000-0000-4000-8000-000000000001";
const shopId = "10000000-0000-4000-8000-000000000001";
const invoice = { id, invoiceNumber: "OLD", effectiveTotal: 10000, effectivePaid: 2000, effectiveDue: 8000 };
const detail: InvoiceDetail = { id, shopId, invoiceNumber: "OLD", originalInvoiceNumber: "OLD", originalCustomerId: null, originalDelivered: false, revision: 0, changes: [], originalTotalDirham: 10000, effectiveTotalDirham: 10000, effectivePaidDirham: 2000, effectiveDueDirham: 8000, businessDate: "2026-10-03", recordedAt: "2026-10-03T00:00:00Z", createdBy: null, creatorName: null, delivered: false, customer: null, payments: [], corrections: [] };
const permissions = { payment: true, requestCorrection: true, requestReplacement: true, approveCorrection: false, approveReplacement: false };
describe("invoice operations UI retry and refresh", () => {
  it("refreshes authoritative number and balance when no attempt is pending", () => {
    const props = { shopId, disabled: false, onSaved: vi.fn(), onStateChange: vi.fn(), onActivityChange: vi.fn(), initialInvoice: invoice };
    const view = render(createElement(InvoicePayment, props));
    view.rerender(createElement(InvoicePayment, { ...props, initialInvoice: { ...invoice, invoiceNumber: "NEW", effectiveTotal: 9000, effectiveDue: 7000 } }));
    expect(screen.getByText("Invoice NEW")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash amount (QAR)"), { target: { value: "75.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot exceed");
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it("keeps uncertain payment retry enabled and preserves its payload after a denied retry", async () => {
    mocks.payment.mockResolvedValueOnce({ ok: false, uncertain: true, message: "Uncertain" }).mockResolvedValueOnce({ ok: false, uncertain: false, message: "Sign in again" }).mockResolvedValueOnce({ ok: true, receipt: { ok: true, invoice_id: id, payment_id: "a9000000-0000-4000-8000-000000000009", effective_paid: 4000, effective_due: 6000 } });
    render(createElement(InvoiceOperations, { detail, permissions }));
    fireEvent.change(screen.getByLabelText("Cash amount (QAR)"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    const retry = await screen.findByRole("button", { name: "Retry payment" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await screen.findByText("Sign in again");
    expect((screen.getByRole("button", { name: "Request financial correction" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    await screen.findByText("Payment recorded.");
    expect(mocks.payment).toHaveBeenCalledTimes(3);
    expect(mocks.payment.mock.calls[1][0]).toEqual(mocks.payment.mock.calls[0][0]);
    expect(mocks.payment.mock.calls[2][0]).toEqual(mocks.payment.mock.calls[0][0]);
  });

  it("does not discard an uncertain correction request when a later retry is denied", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: false, uncertain: true, message: "Uncertain request" }).mockResolvedValueOnce({ ok: false, uncertain: false, message: "No access" }).mockResolvedValueOnce({ ok: true });
    render(createElement(InvoiceOperations, { detail, permissions }));
    fireEvent.click(screen.getByRole("button", { name: "Request financial correction" }));
    fireEvent.change(screen.getByLabelText("Adjustment amount (QAR)"), { target: { value: "10.00" } });
    fireEvent.change(screen.getByLabelText("Request reason"), { target: { value: "Correct total" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact operation" }));
    await screen.findByText("No access");
    expect(screen.getByRole("button", { name: "Submit request" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact operation" }));
    await screen.findByText("Operation confirmed and saved.");
    expect(mocks.operation).toHaveBeenCalledTimes(3);
    expect(mocks.operation.mock.calls[1]).toEqual(mocks.operation.mock.calls[0]);
    expect(mocks.operation.mock.calls[2]).toEqual(mocks.operation.mock.calls[0]);
  });
});
