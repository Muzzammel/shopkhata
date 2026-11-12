export type CustomerSearchCandidate = {
  id: string;
  name: string | null;
  mobile: string | null;
  public_id: string;
};

export const RELEVANCE_EXACT = 1;
export const RELEVANCE_PREFIX = 2;
export const RELEVANCE_PARTIAL = 3;

export const INITIAL_SUGGESTIONS_LIMIT = 3;
export const CUSTOMER_SEARCH_PAGE_SIZE = 20;

/**
 * Categorizes a customer match into relevance tiers:
 * 1. Exact customer ID or mobile match first.
 * 2. Customer name or mobile prefix match next.
 * 3. Other partial matches afterward.
 */
export function getCustomerRelevanceRank(customer: CustomerSearchCandidate, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return RELEVANCE_PARTIAL;

  const publicId = (customer.public_id || "").trim().toLowerCase();
  const mobile = (customer.mobile || "").trim().toLowerCase();
  const name = (customer.name || "").trim().toLowerCase();

  // Tier 1: Exact customer ID or mobile match first.
  if (publicId === query || (mobile.length > 0 && mobile === query)) {
    return RELEVANCE_EXACT;
  }

  // Tier 2: Customer name or mobile prefix match next.
  if ((name.length > 0 && name.startsWith(query)) || (mobile.length > 0 && mobile.startsWith(query))) {
    return RELEVANCE_PREFIX;
  }

  // Tier 3: Other partial matches afterward.
  return RELEVANCE_PARTIAL;
}

/**
 * Compares two customers by relevance first, then by name ascending (nulls last),
 * then by public_id ascending, then by id ascending for determinism.
 */
export function compareCustomersByRelevance(
  left: CustomerSearchCandidate,
  right: CustomerSearchCandidate,
  rawQuery: string
): number {
  const leftRank = getCustomerRelevanceRank(left, rawQuery);
  const rightRank = getCustomerRelevanceRank(right, rawQuery);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  // Tie-breaker 1: Customer name ascending (nulls last, case-insensitive)
  const leftName = (left.name || "").trim().toLowerCase();
  const rightName = (right.name || "").trim().toLowerCase();
  if (leftName && rightName) {
    const cmp = leftName.localeCompare(rightName);
    if (cmp !== 0) return cmp;
  } else if (leftName && !rightName) {
    return -1;
  } else if (!leftName && rightName) {
    return 1;
  }

  // Tie-breaker 2: public_id ascending (case-insensitive)
  const leftPublicId = (left.public_id || "").trim().toLowerCase();
  const rightPublicId = (right.public_id || "").trim().toLowerCase();
  const publicIdCmp = leftPublicId.localeCompare(rightPublicId);
  if (publicIdCmp !== 0) return publicIdCmp;

  // Tie-breaker 3: ID ascending for determinism
  return left.id.localeCompare(right.id);
}

/**
 * Returns a sorted shallow copy of matching customers ordered by relevance:
 * 1. Exact customer ID or mobile match.
 * 2. Customer name or mobile prefix match.
 * 3. Other partial matches.
 */
export function rankCustomersByRelevance<T extends CustomerSearchCandidate>(
  customers: readonly T[],
  rawQuery: string
): T[] {
  return [...customers].sort((left, right) => compareCustomersByRelevance(left, right, rawQuery));
}

