import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  CUSTOMER_SEARCH_PAGE_SIZE,
  getCustomerRelevanceRank,
  INITIAL_SUGGESTIONS_LIMIT,
  rankCustomersByRelevance,
  RELEVANCE_EXACT,
  RELEVANCE_PARTIAL,
  RELEVANCE_PREFIX,
  type CustomerSearchCandidate,
} from "@/lib/customer-search";
import { searchShopCustomers } from "@/app/(app)/workspace-actions";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  can: vi.fn(),
  supabase: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentActor: mocks.actor,
  can: mocks.can,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: mocks.supabase,
}));

describe("customer relevance ranking logic", () => {
  it("assigns Tier 1 to exact customer ID or mobile matches", () => {
    const customer: CustomerSearchCandidate = {
      id: "cust-1",
      name: "Ahmed Ali",
      mobile: "55123456",
      public_id: "CUS-00123",
    };

    // Exact customer ID match (case-insensitive)
    expect(getCustomerRelevanceRank(customer, "CUS-00123")).toBe(RELEVANCE_EXACT);
    expect(getCustomerRelevanceRank(customer, "cus-00123")).toBe(RELEVANCE_EXACT);
    expect(getCustomerRelevanceRank(customer, "  CUS-00123  ")).toBe(RELEVANCE_EXACT);

    // Exact mobile match
    expect(getCustomerRelevanceRank(customer, "55123456")).toBe(RELEVANCE_EXACT);
    expect(getCustomerRelevanceRank(customer, " 55123456 ")).toBe(RELEVANCE_EXACT);
  });

  it("assigns Tier 2 to customer name or mobile prefix matches", () => {
    const customer: CustomerSearchCandidate = {
      id: "cust-2",
      name: "Khalid Mansoor",
      mobile: "77654321",
      public_id: "CUS-00456",
    };

    // Customer name prefix match (case-insensitive)
    expect(getCustomerRelevanceRank(customer, "khalid")).toBe(RELEVANCE_PREFIX);
    expect(getCustomerRelevanceRank(customer, "KHA")).toBe(RELEVANCE_PREFIX);
    expect(getCustomerRelevanceRank(customer, "Khalid Mansoor")).toBe(RELEVANCE_PREFIX);

    // Mobile prefix match
    expect(getCustomerRelevanceRank(customer, "7765")).toBe(RELEVANCE_PREFIX);
    expect(getCustomerRelevanceRank(customer, "77")).toBe(RELEVANCE_PREFIX);
  });

  it("assigns Tier 3 to other partial matches", () => {
    const customer: CustomerSearchCandidate = {
      id: "cust-3",
      name: "Abdul Rahman Mansoor",
      mobile: "33776544",
      public_id: "CUS-00789",
    };

    // Name substring (not prefix)
    expect(getCustomerRelevanceRank(customer, "Rahman")).toBe(RELEVANCE_PARTIAL);
    expect(getCustomerRelevanceRank(customer, "Mansoor")).toBe(RELEVANCE_PARTIAL);

    // Mobile substring (not prefix)
    expect(getCustomerRelevanceRank(customer, "7765")).toBe(RELEVANCE_PARTIAL);

    // Public ID prefix or substring when not exact
    expect(getCustomerRelevanceRank(customer, "CUS-00")).toBe(RELEVANCE_PARTIAL);
    expect(getCustomerRelevanceRank(customer, "789")).toBe(RELEVANCE_PARTIAL);
  });

  it("handles null or empty names and mobiles safely", () => {
    const customer: CustomerSearchCandidate = {
      id: "cust-4",
      name: null,
      mobile: null,
      public_id: "CUS-00999",
    };

    expect(getCustomerRelevanceRank(customer, "CUS-00999")).toBe(RELEVANCE_EXACT);
    expect(getCustomerRelevanceRank(customer, "999")).toBe(RELEVANCE_PARTIAL);
    expect(getCustomerRelevanceRank(customer, "")).toBe(RELEVANCE_PARTIAL);
  });

  it("orders matches by relevance rather than simple alphabetical order", () => {
    const candidates: CustomerSearchCandidate[] = [
      { id: "1", name: "Aaron Abbas", mobile: "99123499", public_id: "CUS-00001" }, // Tier 3: partial mobile
      { id: "2", name: "Abby Adams", mobile: "99123488", public_id: "CUS-00002" },  // Tier 3: partial mobile
      { id: "3", name: "Adam Al-Noor", mobile: "99123477", public_id: "CUS-00003" },// Tier 3: partial mobile
      { id: "4", name: "Zackaria", mobile: "1234", public_id: "CUS-00099" },        // Tier 1: exact mobile match
      { id: "5", name: "1234 Store", mobile: "88888888", public_id: "CUS-00050" },  // Tier 2: name prefix match
      { id: "6", name: "Yousef", mobile: "12345678", public_id: "CUS-00060" },      // Tier 2: mobile prefix match
    ];

    const ranked = rankCustomersByRelevance(candidates, "1234");

    // Zackaria (Tier 1: exact mobile) MUST be ranked first, despite starting with 'Z'
    expect(ranked[0].name).toBe("Zackaria");

    // Next two must be Tier 2 prefix matches (alphabetically ordered within tier)
    expect(ranked[1].name).toBe("1234 Store");
    expect(ranked[2].name).toBe("Yousef");

    // Other partial matches (Tier 3) must be ranked after Tier 1 and Tier 2
    expect(ranked[3].name).toBe("Aaron Abbas");
    expect(ranked[4].name).toBe("Abby Adams");
    expect(ranked[5].name).toBe("Adam Al-Noor");
  });

  it("breaks ties within the same relevance tier alphabetically by name then public_id", () => {
    const candidates: CustomerSearchCandidate[] = [
      { id: "3", name: "Ali Zaid", mobile: "5550003", public_id: "CUS-003" },
      { id: "1", name: "Ali Ahmad", mobile: "5550001", public_id: "CUS-002" },
      { id: "2", name: "Ali Ahmad", mobile: "5550002", public_id: "CUS-001" },
      { id: "4", name: null, mobile: "5550004", public_id: "CUS-004" },
    ];

    // All match prefix "Ali" (or null which goes to Tier 3)
    const ranked = rankCustomersByRelevance(candidates, "Ali");

    // Both "Ali Ahmad" first, ordered by public_id: CUS-001 before CUS-002
    expect(ranked[0].public_id).toBe("CUS-001");
    expect(ranked[1].public_id).toBe("CUS-002");
    expect(ranked[2].name).toBe("Ali Zaid");
    expect(ranked[3].name).toBeNull();
  });
});

describe("searchShopCustomers server action", () => {
  const shopId = "10000000-0000-4000-8000-000000000001";
  const actor = { id: "user-1", email: "staff@shopkhata.local", role: "staff", display_name: "Staff" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.mockResolvedValue(actor);
    mocks.can.mockReturnValue(true);
  });

  function setupMockSupabase(customers: CustomerSearchCandidate[], shopActive = true) {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: shopActive ? { id: shopId } : null,
      error: null,
    });
    const shopsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation((col: string, val: unknown) => {
        if (col === "is_active" && val === true) return { maybeSingle };
        return shopsChain;
      }),
    };

    const customersChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: customers, error: null }),
    };

    mocks.supabase.mockResolvedValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "shops") return shopsChain;
        if (table === "customers") return customersChain;
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    return { shopsChain, customersChain };
  }

  it("returns a maximum of three suggestions initially when offset is 0", async () => {
    const mockCustomers: CustomerSearchCandidate[] = [
      { id: "1", name: "Aaron", mobile: "99123401", public_id: "CUS-001" },
      { id: "2", name: "Abby", mobile: "99123402", public_id: "CUS-002" },
      { id: "3", name: "Adam", mobile: "99123403", public_id: "CUS-003" },
      { id: "4", name: "Zack", mobile: "1234", public_id: "CUS-004" }, // Tier 1: exact mobile
      { id: "5", name: "1234 Shop", mobile: "55555555", public_id: "CUS-005" }, // Tier 2: prefix
    ];

    setupMockSupabase(mockCustomers);

    const result = await searchShopCustomers(shopId, "1234", 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Must return at most 3 suggestions
    expect(result.customers).toHaveLength(INITIAL_SUGGESTIONS_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(3);

    // Zack (exact match) MUST be the first suggestion, not simply the first alphabetically
    expect(result.customers[0].name).toBe("Zack");
    expect(result.customers[1].name).toBe("1234 Shop");
    expect(result.customers[2].name).toBe("Aaron");
  });

  it("supports 'Show more results' pagination starting from nextOffset", async () => {
    const mockCustomers: CustomerSearchCandidate[] = Array.from({ length: 25 }, (_, i) => ({
      id: `id-${i}`,
      name: `Customer ${i < 10 ? "0" + i : i}`,
      mobile: `5500${i}`,
      public_id: `CUS-${100 + i}`,
    }));

    setupMockSupabase(mockCustomers);

    // Initial search (offset 0)
    const page1 = await searchShopCustomers(shopId, "Customer", 0);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.customers).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextOffset).toBe(3);

    // Show more (offset 3): loads next batch (up to CUSTOMER_SEARCH_PAGE_SIZE = 20)
    const page2 = await searchShopCustomers(shopId, "Customer", page1.nextOffset);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.customers).toHaveLength(CUSTOMER_SEARCH_PAGE_SIZE);
    expect(page2.hasMore).toBe(true); // 25 total > 23
    expect(page2.nextOffset).toBe(23);

    // Third page (offset 23): loads remaining 2
    const page3 = await searchShopCustomers(shopId, "Customer", page2.nextOffset);
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.customers).toHaveLength(2);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextOffset).toBe(25);
  });

  it("enforces shop isolation and permissions", async () => {
    // 1. Unauthorized actor
    mocks.can.mockReturnValue(false);
    const denied = await searchShopCustomers(shopId, "Ali", 0);
    expect(denied).toEqual({ ok: false, message: "You cannot access this shop." });

    // 2. Inactive shop
    mocks.can.mockReturnValue(true);
    setupMockSupabase([], false);
    const inactive = await searchShopCustomers(shopId, "Ali", 0);
    expect(inactive).toEqual({ ok: false, message: "You cannot access this shop." });

    // 3. Shop isolation: Supabase query filters by eq("shop_id", shopId)
    const { customersChain } = setupMockSupabase([]);
    await searchShopCustomers(shopId, "Ali", 0);
    expect(customersChain.eq).toHaveBeenCalledWith("shop_id", shopId);
  });

  it("rejects invalid inputs safely", async () => {
    expect(await searchShopCustomers(null, "Ali")).toEqual({ ok: false, message: "Enter a customer search." });
    expect(await searchShopCustomers(shopId, null)).toEqual({ ok: false, message: "Enter a customer search." });
    expect(await searchShopCustomers(shopId, "a")).toEqual({ ok: true, customers: [], hasMore: false, nextOffset: 0 });
    expect(await searchShopCustomers(shopId, "a".repeat(101))).toEqual({ ok: false, message: "Shorten the customer search." });
  });
});
