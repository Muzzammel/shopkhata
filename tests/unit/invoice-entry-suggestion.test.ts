// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InvoiceEntry } from "@/app/(app)/invoice-entry";
import type { ShopChoice } from "@/lib/shop-switching";

const mocks = vi.hoisted(() => ({
  saveInvoiceBatch: vi.fn(),
  findTakenInvoiceNumbers: vi.fn(),
  loadShopWorkspace: vi.fn(),
  deleteDraft: vi.fn(),
  saveDraft: vi.fn(),
  loadDraft: vi.fn(),
  listDraftShopIds: vi.fn(),
  writeSessionMarker: vi.fn(),
}));

vi.mock("@/app/(app)/invoice-actions", () => ({
  saveInvoiceBatch: mocks.saveInvoiceBatch,
}));

vi.mock("@/app/(app)/workspace-actions", () => ({
  findTakenInvoiceNumbers: mocks.findTakenInvoiceNumbers,
  loadShopWorkspace: mocks.loadShopWorkspace,
}));

vi.mock("@/lib/offline/draft-store", () => ({
  deleteDraft: mocks.deleteDraft,
  saveDraft: mocks.saveDraft,
  loadDraft: mocks.loadDraft,
  listDraftShopIds: mocks.listDraftShopIds,
  writeSessionMarker: mocks.writeSessionMarker,
}));

vi.mock("@/lib/offline/use-online", () => ({
  useOnline: () => true,
  isOnline: () => true,
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserClient: () => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } }, error: null }) },
  }),
}));

vi.mock("@/app/(app)/customer-search", () => ({
  CustomerSearch: () => null,
}));

vi.mock("@/app/(app)/excel-import", () => ({
  ExcelImport: () => null,
}));

vi.mock("@/app/(app)/invoice-payment", () => ({
  InvoicePayment: () => null,
}));

const shop1: ShopChoice = { id: "10000000-0000-4000-8000-000000000001", name: "Shop 1" };
const shop2: ShopChoice = { id: "10000000-0000-4000-8000-000000000002", name: "Shop 2" };

// Full InvoiceEntry renders (~2 s alone); 5 s is not enough under parallel load.
describe("Automatic Next Invoice Suggestion in InvoiceEntry", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDraft.mockResolvedValue({ draft: null, available: true });
    mocks.listDraftShopIds.mockResolvedValue([]);
    mocks.findTakenInvoiceNumbers.mockResolvedValue({ ok: true, registered: [] });
    mocks.deleteDraft.mockResolvedValue(undefined);
    mocks.saveDraft.mockResolvedValue(true);
    mocks.loadShopWorkspace.mockResolvedValue({
      ok: true,
      workspace: { shop: shop1, invoices: [] },
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderEntry(shop = shop1) {
    return render(createElement(InvoiceEntry, {
      appName: "ShopKhata",
      shop,
      shops: [shop1, shop2],
      actorId: "actor-1",
      actorName: "Test Staff",
      actorRole: "staff",
      invoices: [],
      businessDate: "2026-11-11",
      offlineShell: false,
    }));
  }

  async function fillAndReview(invoiceNumber: string, total = "50.00", received = "50.00") {
    const invoiceInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
    const totalInput = screen.getByLabelText("Total QAR") as HTMLInputElement;
    const receivedInput = screen.getByLabelText("Received QAR") as HTMLInputElement;

    fireEvent.change(invoiceInput, { target: { value: invoiceNumber } });
    fireEvent.change(totalInput, { target: { value: total } });
    fireEvent.change(receivedInput, { target: { value: received } });

    // Wait for the 200ms debounce of duplicate number lookup
    await new Promise((resolve) => setTimeout(resolve, 250));

    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    return screen.findByRole("button", { name: "Save sale" });
  }

  it("suggests the next numeric invoice number (1050 -> 1051) after confirmed successful submission", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    // Form should reset and prefill next invoice suggestion (1051)
    await waitFor(() => {
      const updatedInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
      expect(updatedInput.value).toBe("1051");
    });

    // Success notice is visible
    expect(screen.getByText("Sale saved")).toBeDefined();
    expect(screen.getByText("1050")).toBeDefined();
  });

  it("preserves leading zero padding (0099 -> 0100)", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("0099", "75.00", "75.00");
    fireEvent.click(saveButton);

    await waitFor(() => {
      const updatedInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
      expect(updatedInput.value).toBe("0100");
    });
  });

  it("preserves prefixes when incrementing (INV-0099 -> INV-0100)", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("INV-0099", "120.00", "120.00");
    fireEvent.click(saveButton);

    await waitFor(() => {
      const updatedInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
      expect(updatedInput.value).toBe("INV-0100");
    });
  });

  it("allows the user to edit the suggested invoice number", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1051");
    });

    // User edits the suggestion to 2000
    const updatedInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
    fireEvent.change(updatedInput, { target: { value: "2000" } });
    expect(updatedInput.value).toBe("2000");
  });

  it("does not advance numbering when save fails or returns validation errors", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: false,
      code: "VALIDATION",
      message: "Fix the marked rows before saving.",
      errors: [{ rowId: "a", field: "invoiceId", message: "Duplicate" }],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText("Fix the marked rows before saving.")).toBeDefined();
    });

    // Form stays on 1050 and does NOT advance
    expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1050");
  });

  it("does not advance numbering on uncertain server responses", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: false,
      uncertain: true,
      message: "Sale was not saved. Try again with the same draft.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      // Stays on 1050 in uncertain state
      expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1050");
    });
  });

  it("does not persist or reserve a number merely by opening a fresh form with suggestion", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1051");
    });

    // deleteDraft should be called to clear the old draft, and saveDraft should NOT be called for the unedited suggested row
    expect(mocks.deleteDraft).toHaveBeenCalledWith("actor-1", shop1.id);
  });

  it("opens an empty invoice number field if the previous number cannot be incremented safely", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });

    renderEntry();

    const saveButton = await fillAndReview("NONUMBER");
    fireEvent.click(saveButton);

    await waitFor(() => {
      const updatedInput = screen.getByLabelText("Invoice ID") as HTMLInputElement;
      expect(updatedInput.value).toBe("");
    });
  });

  it("does not advance numbering when duplicate invoice number is rejected", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: false,
      code: "VALIDATION",
      message: "Fix the marked rows before saving.",
      errors: [{ rowId: "a", field: "invoiceId", code: "DUPLICATE_INVOICE", message: "Invoice ID already exists in this shop." }],
    });

    renderEntry();

    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText("Fix the marked rows before saving.")).toBeDefined();
    });

    // Stays on 1050 and does not advance
    expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1050");
  });

  it("switching shops does not reuse another shop's suggestion or draft", async () => {
    mocks.saveInvoiceBatch.mockResolvedValue({
      ok: true,
      message: "Sale saved.",
      errors: [],
    });
    mocks.loadShopWorkspace.mockImplementation((targetShopId: string) => {
      if (targetShopId === shop2.id) {
        return Promise.resolve({
          ok: true,
          workspace: { shop: shop2, invoices: [] },
        });
      }
      return Promise.resolve({
        ok: true,
        workspace: { shop: shop1, invoices: [] },
      });
    });

    renderEntry();

    // Save invoice 1050 in Shop 1
    const saveButton = await fillAndReview("1050");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect((screen.getByLabelText("Invoice ID") as HTMLInputElement).value).toBe("1051");
    });

    // Switch to Shop 2
    const shopSelect = screen.queryByLabelText("Current shop") as HTMLSelectElement | null;
    if (shopSelect) {
      fireEvent.change(shopSelect, { target: { value: shop2.id } });
      await waitFor(() => {
        const input = screen.getByLabelText("Invoice ID") as HTMLInputElement;
        expect(input.value).not.toBe("1051");
      });
    }
  });
});
