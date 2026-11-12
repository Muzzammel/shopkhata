// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CustomerSearch } from "@/app/(app)/customer-search";
import type { WorkspaceCustomer } from "@/lib/shop-workspace";

const mocks = vi.hoisted(() => ({
  searchShopCustomers: vi.fn(),
}));

vi.mock("@/app/(app)/workspace-actions", () => ({
  searchShopCustomers: mocks.searchShopCustomers,
}));

describe("CustomerSearch Component", () => {
  const shopId = "10000000-0000-4000-8000-000000000001";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("displays a maximum of three suggestions initially when search returns results", async () => {
    const suggestions: WorkspaceCustomer[] = [
      { id: "c1", name: "Zack", mobile: "1234", public_id: "CUS-001" },
      { id: "c2", name: "1234 Store", mobile: "55551234", public_id: "CUS-002" },
      { id: "c3", name: "Yousef", mobile: "12345678", public_id: "CUS-003" },
    ];

    mocks.searchShopCustomers.mockResolvedValue({
      ok: true,
      customers: suggestions,
      hasMore: true,
      nextOffset: 3,
    });

    const onSelect = vi.fn();
    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "1234" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Zack");
    expect(options[1].textContent).toContain("1234 Store");
    expect(options[2].textContent).toContain("Yousef");

    // "Show more results" button is visible when hasMore is true
    expect(screen.getByRole("button", { name: "Show more results" })).toBeDefined();
  });

  it("reveals additional customers when clicking 'Show more results'", async () => {
    const initialSuggestions: WorkspaceCustomer[] = [
      { id: "c1", name: "Zack", mobile: "1234", public_id: "CUS-001" },
      { id: "c2", name: "1234 Store", mobile: "55551234", public_id: "CUS-002" },
      { id: "c3", name: "Yousef", mobile: "12345678", public_id: "CUS-003" },
    ];

    const moreCustomers: WorkspaceCustomer[] = [
      { id: "c4", name: "Aaron", mobile: "99123499", public_id: "CUS-004" },
      { id: "c5", name: "Abby", mobile: "99123488", public_id: "CUS-005" },
    ];

    mocks.searchShopCustomers
      .mockResolvedValueOnce({
        ok: true,
        customers: initialSuggestions,
        hasMore: true,
        nextOffset: 3,
      })
      .mockResolvedValueOnce({
        ok: true,
        customers: moreCustomers,
        hasMore: false,
        nextOffset: 5,
      });

    const onSelect = vi.fn();
    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "1234" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    const showMoreButton = screen.getByRole("button", { name: "Show more results" });
    fireEvent.click(showMoreButton);

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(5);
    });

    const allOptions = screen.getAllByRole("option");
    expect(allOptions[3].textContent).toContain("Aaron");
    expect(allOptions[4].textContent).toContain("Abby");

    // Once hasMore is false, the button is no longer rendered
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
  });

  it("supports keyboard navigation (ArrowDown, ArrowUp, Enter, Escape)", async () => {
    const suggestions: WorkspaceCustomer[] = [
      { id: "c1", name: "Customer One", mobile: "55001", public_id: "CUS-001" },
      { id: "c2", name: "Customer Two", mobile: "55002", public_id: "CUS-002" },
      { id: "c3", name: "Customer Three", mobile: "55003", public_id: "CUS-003" },
    ];

    mocks.searchShopCustomers.mockResolvedValue({
      ok: true,
      customers: suggestions,
      hasMore: false,
      nextOffset: 3,
    });

    const onSelect = vi.fn();
    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "Customer" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    const options = screen.getAllByRole("option");

    // ArrowDown moves focus to first option (index 0)
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    // ArrowDown moves focus to second option (index 1)
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    // ArrowUp moves focus back to first option (index 0)
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    // Enter selects the active option
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(suggestions[0]);

    // Selected customer view is displayed
    expect(screen.getByText(/Customer One/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear customer" })).toBeDefined();
  });

  it("dismisses results dropdown on Escape", async () => {
    const suggestions: WorkspaceCustomer[] = [
      { id: "c1", name: "Customer One", mobile: "55001", public_id: "CUS-001" },
    ];

    mocks.searchShopCustomers.mockResolvedValue({
      ok: true,
      customers: suggestions,
      hasMore: false,
      nextOffset: 1,
    });

    const onSelect = vi.fn();
    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "Customer" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("selects a customer on click and clears selection", async () => {
    const suggestions: WorkspaceCustomer[] = [
      { id: "c1", name: "Customer One", mobile: "55001", public_id: "CUS-001" },
    ];

    mocks.searchShopCustomers.mockResolvedValue({
      ok: true,
      customers: suggestions,
      hasMore: false,
      nextOffset: 1,
    });

    const onSelect = vi.fn();
    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "Customer" } });

    const option = await screen.findByRole("option");
    fireEvent.click(option);

    expect(onSelect).toHaveBeenCalledWith(suggestions[0]);
    expect(screen.getByText(/Customer One/)).toBeDefined();

    // Click "Clear customer"
    const clearButton = screen.getByRole("button", { name: "Clear customer" });
    fireEvent.click(clearButton);

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("displays loading and error states appropriately", async () => {
    mocks.searchShopCustomers.mockResolvedValue({
      ok: false,
      message: "Customer search is unavailable.",
    });

    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect: vi.fn() }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "SearchTerm" } });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Customer search is unavailable.");
    });
  });

  it("displays 'No customers found.' when search has zero matches", async () => {
    mocks.searchShopCustomers.mockResolvedValue({
      ok: true,
      customers: [],
      hasMore: false,
      nextOffset: 0,
    });

    render(createElement(CustomerSearch, { shopId, disabled: false, onSelect: vi.fn() }));

    const input = screen.getByRole("combobox", { name: "Customer search" });
    fireEvent.change(input, { target: { value: "Nonexistent" } });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("No customers found.");
    });
  });
});
