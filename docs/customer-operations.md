# Customer operations and shop expenses

This document describes the customer and expense operations introduced by the Big Slice 2 migration and UI. It supplements the existing invoice-operation rules; earlier plans and status snapshots remain historical evidence.

## Customer identity and authorization

Customers are shop-scoped records. A name, mobile number, or both identify a customer within one shop; the application does not create a global person identity. The database RPC normalizes optional text, requires at least one identity field, serializes concurrent duplicate checks, and rejects a duplicate explicitly. The browser obtains the actor from the Supabase session. Shop assignments and roles are checked in server actions and in security-definer RPCs, while RLS remains the read boundary for customers, ledgers, balances, invoices, expenses, corrections, and attachment metadata.

## Balance and ledger semantics

Customer due is the sum of that customer's canonical effective invoice dues. For each invoice, effective due is:

`original invoice total + approved invoice corrections - payments and approved payment corrections - applied customer credit`

The existing invoice balance projection is the source used by invoice detail, the customer balance projection, the customer list, and payment allocation. No mutable customer balance is stored. Available customer credit is:

`approved overpayment credit issued to the customer - immutable credit applications`

Credit can only originate from the existing manager/owner-approved overpayment workflow. A cash amount above due is not silently represented as negative due or arbitrary credit. Credit application is an append-only event allocated to invoice obligations; the same applied amount reduces due and available credit.

The customer ledger emits the original invoice obligation, approved invoice and payment corrections with their signed effect, cash payments, and applied credit. Rows carry business date, recording timestamp, reference, invoice, and actor. The UI orders events by business date, recorded time, and source event ID, then computes a running balance from those rows. The final ledger balance must equal the customer balance projection and the sum of effective invoice dues.

## Customer payment allocation

The customer payment preview allocates integer dirham to outstanding invoices by oldest business date, then canonical invoice ID. The database repeats the allocation against current effective due inside the transaction, locks eligible invoices in the same order, and inserts all invoice payment allocations and one immutable payment batch atomically. An amount above current due rolls back. A scoped idempotency key returns the original result for an exact retry and rejects reuse with a different fingerprint. Customer payments and credit applications use the current Qatar business date and are rejected for a closed date.

## Governed credit application

Only credit already created by an approved excess-payment operation is available to apply. The user reviews the proposed FIFO invoice allocation before submitting. The RPC locks the customer's approved credits and eligible invoices, checks available credit and due again, and writes one immutable application row per allocation plus an immutable request batch. Concurrent applications cannot consume the same credit twice; retries use the original batch receipt.

## Expense lifecycle and correction

Expenses are shop-scoped operating costs, separate from invoice and payment records. Amounts persist as positive integer dirham, with a controlled category list (`rent`, `utilities`, `supplies`, `transport`, `maintenance`, `other`), business date, description, creator, and recording timestamp. A current-date expense is available to authorized shop staff. A backdated expense requires an owner and a reason. Future dates and closed business dates are rejected; the date must be reopened through the existing governed close lifecycle before a new expense can be recorded.

Expense rows cannot be updated or deleted through application roles. A correction request retains the proposed amount, category, description, reason, requester, and timestamp. A manager or owner records an immutable approval or rejection. Only the latest approved correction based on the prior effective correction becomes effective; stale competing requests cannot overwrite a newer correction. The original expense and every request/decision remain auditable.

## Private receipt attachments

Receipts use the private Supabase Storage bucket `expense-receipts`, limited to JPEG, PNG, WebP, or PDF files up to 10 MiB. The generated object path is `shop UUID / expense UUID / random UUID.extension`; the original filename is display metadata only. Storage insertion requires shop access and a real expense in that shop. Reads require shop access and a matching attachment metadata row. Objects cannot be updated or deleted through authenticated policies. The registration RPC checks the uploaded object, path, type, size, and expense/shop relationship before it writes immutable metadata. Attachment registration is idempotent; an uncertain or failed upload/link is shown as incomplete rather than as a successful expense with a receipt.

## Reconciliation and verification

The database views `invoice_effective_balances`, `effective_invoices`, `customer_financial_balances`, `customer_ledger`, and `effective_expenses` provide shared financial read semantics. Indexes support invoice allocations, ledger joins, FIFO credit use, shop/date expense history, and correction history. The schema and customer-expense pgTAP suites exercise projections, isolation, FIFO allocation, retries, role checks, correction approval, and effective expense values. Real local Supabase integration and Playwright tests cover concurrency, receipt privacy, UI workflow, and cross-shop access. Record actual gate results in the Big Slice 2 implementation record; a source test or an unavailable local service is not a database pass.
