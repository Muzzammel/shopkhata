"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { WorkspaceCustomer } from "@/lib/shop-workspace";

import { searchShopCustomers } from "./workspace-actions";
import styles from "@/app/ui.module.css";

export function CustomerSearch({ shopId, disabled, onSelect, initial = null }: {
  shopId: string;
  disabled: boolean;
  /** Customer already linked to this row, e.g. from a restored draft. */
  initial?: WorkspaceCustomer | null;
  onSelect: (customer: WorkspaceCustomer | null) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceCustomer[]>([]);
  const [selected, setSelected] = useState<WorkspaceCustomer | null>(initial);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [message, setMessage] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestSequence = useRef(0);

  useEffect(() => {
    const normalized = query.trim();
    const requestId = ++requestSequence.current;
    if (normalized.length < 2) return () => {
      if (requestId === requestSequence.current) requestSequence.current += 1;
    };
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchShopCustomers(shopId, normalized).then((response) => {
        if (requestId !== requestSequence.current) return;
        if (!response.ok) {
          setResults([]);
          setHasMore(false);
          setMessage(response.message);
        } else {
          setResults(response.customers);
          setHasMore(response.hasMore);
          setNextOffset(response.nextOffset);
          setActiveIndex(-1);
          setMessage(response.customers.length ? "" : "No customers found.");
        }
      }).catch(() => {
        if (requestId === requestSequence.current) {
          setResults([]);
          setHasMore(false);
          setMessage("Customer search is unavailable.");
        }
      }).finally(() => {
        if (requestId === requestSequence.current) setLoading(false);
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      if (requestId === requestSequence.current) requestSequence.current += 1;
    };
  }, [query, shopId]);

  async function showMore() {
    if (disabled || loading) return;
    const requestId = ++requestSequence.current;
    const searchTerm = query.trim();
    setLoading(true);
    try {
      const response = await searchShopCustomers(shopId, searchTerm, nextOffset);
      if (requestId !== requestSequence.current) return;
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      setResults((current) => [...current, ...response.customers]);
      setHasMore(response.hasMore);
      setNextOffset(response.nextOffset);
    } catch {
      if (requestId === requestSequence.current) setMessage("Customer search is unavailable.");
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }

  function choose(customer: WorkspaceCustomer) {
    setSelected(customer);
    setQuery("");
    setResults([]);
    setMessage("");
    setActiveIndex(-1);
    onSelect(customer);
  }

  function clearSelection() {
    setSelected(null);
    onSelect(null);
  }

  return <div className={styles.customerSearch}>
    <label htmlFor={`customer-search-${id}`}>Customer search</label>
    <input
      id={`customer-search-${id}`}
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={results.length > 0}
      aria-controls={`customer-results-${id}`}
      aria-activedescendant={activeIndex >= 0 ? `customer-option-${id}-${activeIndex}` : undefined}
      aria-describedby={`customer-search-status-${id}`}
      autoComplete="off"
      value={selected ? `${selected.name || "Unnamed customer"} | ${selected.mobile || selected.public_id}` : query}
      disabled={disabled || Boolean(selected)}
      placeholder="Search name, mobile, or customer ID"
      onChange={(event) => {
        const nextQuery = event.target.value;
        requestSequence.current += 1;
        setQuery(nextQuery);
        setResults([]);
        setHasMore(false);
        setNextOffset(0);
        setLoading(false);
        setMessage("");
        setActiveIndex(-1);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && results.length) {
          event.preventDefault();
          setActiveIndex((current) => Math.min(results.length - 1, current + 1));
        } else if (event.key === "ArrowUp" && results.length) {
          event.preventDefault();
          setActiveIndex((current) => Math.max(0, current < 0 ? results.length - 1 : current - 1));
        } else if (event.key === "Enter" && activeIndex >= 0) {
          event.preventDefault();
          choose(results[activeIndex]);
        } else if (event.key === "Escape") {
          setResults([]);
          setActiveIndex(-1);
        }
      }}
    />
    {selected && <div className={styles.selectedCustomer}>
      <span>{selected.name || "Unnamed customer"} | {selected.mobile || "No mobile"} | {selected.public_id}</span>
      <button type="button" className={styles.textButton} disabled={disabled} onClick={clearSelection}>Clear customer</button>
    </div>}
    {!selected && results.length > 0 && <ul id={`customer-results-${id}`} className={styles.customerResults} role="listbox" aria-label="Customer search results">
      {results.map((customer, index) => <li key={customer.id}>
        <div id={`customer-option-${id}-${index}`} className={styles.customerResultOption} role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => !disabled && choose(customer)}>
          <span>{customer.name || "Unnamed customer"}</span>
          <small>{customer.mobile || "No mobile"} | {customer.public_id}</small>
        </div>
      </li>)}
    </ul>}
    {hasMore && !selected && <button type="button" className={styles.moreCustomers} disabled={disabled || loading} onClick={() => void showMore()}>Show more results</button>}
    <span id={`customer-search-status-${id}`} className={styles.customerSearchStatus} role="status" aria-live="polite">
      {loading ? "Searching customers..." : message || (results.length ? `${results.length} customer results.` : "Enter at least 2 characters to search.")}
    </span>
  </div>;
}
