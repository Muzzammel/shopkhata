// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InvoicePayment } from "@/app/(app)/invoice-payment";
import { InvoiceOperations } from "@/app/(app)/invoice-operations";
import type { InvoiceDetail } from "@/lib/invoice-detail";

const mocks = vi.hoisted(() => ({ payment: vi.fn(), operation: vi.fn(), refresh: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/app/(app)/payment-actions", () => ({ recordInvoicePayment: mocks.payment, lookupInvoiceForPayment: vi.fn() }));
vi.mock("@/app/(app)/invoice-operation-actions", () => ({ runInvoiceOperation: mocks.operation }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/customer-search", () => ({ CustomerSearch: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const id = "a9000000-0000-4000-8000-000000000001";
const shopId = "10000000-0000-4000-8000-000000000001";
const invoice = { id, invoiceNumber: "OLD", effectiveTotal: 10000, effectivePaid: 2000, effectiveDue: 8000 };
const detail: InvoiceDetail = { id, shopId, invoiceNumber: "OLD", originalInvoiceNumber: "OLD", originalCustomerId: null, originalDelivered: false, revision: 0, changes: [], originalTotalDirham: 10000, effectiveTotalDirham: 10000, effectivePaidDirham: 2000, effectiveCreditAppliedDirham: 0, effectiveDueDirham: 8000, businessDate: "2026-10-03", recordedAt: "2026-10-03T00:00:00Z", createdBy: null, creatorName: null, delivered: false, customer: null, payments: [], corrections: [], people: {}, customerNames: {} };
const permissions = { payment: true, requestCorrection: true, requestReplacement: true, approveCorrection: false, approveReplacement: false };
describe("invoice operations UI retry and refresh", () => {
  it("refreshes authoritative number and balance when no attempt is pending", () => {
    const props = { shopId, disabled: false, onSaved: vi.fn(), onStateChange: vi.fn(), onActivityChange: vi.fn(), initialInvoice: invoice };
    const view = render(createElement(InvoicePayment, props));
    view.rerender(createElement(InvoicePayment, { ...props, initialInvoice: { ...invoice, invoiceNumber: "NEW", effectiveTotal: 9000, effectiveDue: 7000 } }));
    expect(screen.getByText("NEW").closest("p")?.textContent).toBe("Invoice NEW");
    expect(screen.getByText("70.00", { exact: false }).textContent).toContain("QAR 70.00");
    fireEvent.change(screen.getByLabelText("Cash amount (QAR)"), { target: { value: "75.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot exceed");
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it("keeps uncertain payment retry enabled and preserves its payload after a denied retry", async () => {
    mocks.payment.mockResolvedValueOnce({ ok: false, uncertain: true, message: "Uncertain" }).mockResolvedValueOnce({ ok: false, uncertain: false, message: "Sign in again" }).mockResolvedValueOnce({ ok: true, receipt: { ok: true, invoice_id: id, payment_id: "a9000000-0000-4000-8000-000000000009", effective_paid: 4000, effective_due: 6000 } });
    render(createElement(InvoiceOperations, { detail, permissions }));
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    fireEvent.change(screen.getByLabelText("Cash amount (QAR)"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    const retry = await screen.findByRole("button", { name: "Retry payment" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await screen.findByText("Sign in again");
    // Behind the open payment drawer, so hidden from the accessibility tree, but still locked.
    expect((screen.getByRole("button", { name: "Request correction", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    await screen.findByText("Payment recorded.");
    expect(mocks.payment).toHaveBeenCalledTimes(3);
    expect(mocks.payment.mock.calls[1][0]).toEqual(mocks.payment.mock.calls[0][0]);
    expect(mocks.payment.mock.calls[2][0]).toEqual(mocks.payment.mock.calls[0][0]);
  });

  it("does not discard an uncertain correction request when a later retry is denied", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: false, uncertain: true, message: "Uncertain request" }).mockResolvedValueOnce({ ok: false, uncertain: false, message: "No access" }).mockResolvedValueOnce({ ok: true });
    render(createElement(InvoiceOperations, { detail, permissions }));
    fireEvent.click(screen.getByRole("button", { name: "Request correction" }));
    fireEvent.change(screen.getByLabelText("Corrected invoice total (QAR)"), { target: { value: "90.00" } });
    fireEvent.change(screen.getByLabelText("Request reason"), { target: { value: "Correct total" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact operation" }));
    await screen.findByText("No access");
    expect(screen.getByRole("button", { name: "Submit request" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact operation" }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Operation confirmed and saved."));
    expect(mocks.operation).toHaveBeenCalledTimes(3);
    expect(mocks.operation.mock.calls[1]).toEqual(mocks.operation.mock.calls[0]);
    expect(mocks.operation.mock.calls[2]).toEqual(mocks.operation.mock.calls[0]);
  });

  const openCorrection = (value: string) => {
    render(createElement(InvoiceOperations, { detail: { ...detail, effectiveTotalDirham: 100000, effectivePaidDirham: 40000, effectiveDueDirham: 60000 }, permissions }));
    fireEvent.click(screen.getByRole("button", { name: "Request correction" }));
    fireEvent.change(screen.getByLabelText("Corrected invoice total (QAR)"), { target: { value } });
    fireEvent.change(screen.getByLabelText("Request reason"), { target: { value: "Total was entered wrong" } });
  };
  const summary = () => Object.fromEntries([...screen.getByLabelText("Correction summary").querySelectorAll("div")].map((item) => [item.querySelector("dt")!.textContent, item.querySelector("dd")!.textContent]));

  it("treats the entered amount as the corrected total: 1000 to 1500 sends 1500 and shows a difference of 500", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: true });
    openCorrection("1500.00");
    expect(summary()).toEqual({
      "Current invoice total": "QAR 1,000.00", "Corrected invoice total": "QAR 1,500.00", "Calculated difference": "+QAR 500.00",
      "Current payments": "QAR 400.00", "Resulting due after correction": "QAR 1,100.00",
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(mocks.operation).toHaveBeenCalledTimes(1));
    const [operation, command] = mocks.operation.mock.calls[0];
    expect(operation).toBe("request_invoice_correction");
    expect(command).toMatchObject({ payment_id: null, expected_total_dirham: 100000, corrected_total_dirham: 150000 });
    expect(command).not.toHaveProperty("amount_delta_dirham");
  });

  it("shows a decrease as a negative difference and sends the lower corrected total", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: true });
    openCorrection("500");
    expect(summary()["Calculated difference"]).toBe("−QAR 500.00");
    expect(summary()["Resulting due after correction"]).toBe("QAR 100.00");
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(mocks.operation.mock.calls[0][1]).toMatchObject({ corrected_total_dirham: 50000 }));
  });

  it.each([
    ["399.99", /cannot be less than the QAR 400.00 already paid/],
    ["1000.00", /same as the current total/],
    ["abc", /Enter the corrected invoice total/],
    ["10.005", /Enter the corrected invoice total/],
  ])("marks the corrected total field invalid for %s without calling the server", (value, text) => {
    openCorrection(value);
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    const field = screen.getByLabelText("Corrected invoice total (QAR)");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("correction-total-error")!.textContent).toMatch(text);
    expect(field.getAttribute("aria-describedby")).toContain("correction-total-error");
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it("shows a server refusal in a persistent alert and on the field it concerns", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: false, uncertain: false, code: "INVALID_FINANCIAL_RESULT", message: "This correction would leave invalid balances." });
    openCorrection("1500.00");
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert.textContent).toContain("This correction would leave invalid balances.");
    expect(screen.getByLabelText("Corrected invoice total (QAR)").getAttribute("aria-invalid")).toBe("true");
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    // Not an uncertain outcome: nothing to retry, and the form stays editable.
    expect(screen.queryByRole("button", { name: "Retry exact operation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit request" }).matches(":disabled")).toBe(false);
  });

  it("reloads the invoice when the server reports that the total has moved", async () => {
    mocks.operation.mockResolvedValueOnce({ ok: false, uncertain: false, code: "STALE_TOTAL", message: "The invoice total changed." });
    openCorrection("1500.00");
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await screen.findByRole("alert");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
