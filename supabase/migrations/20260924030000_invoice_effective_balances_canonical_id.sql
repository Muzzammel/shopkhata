-- Keep the canonical database ID distinct from the user-facing invoice number
-- when the read model is combined with invoice rows.
alter view public.invoice_effective_balances
  rename column invoice_id to canonical_invoice_id;
