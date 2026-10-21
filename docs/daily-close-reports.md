# Daily closing and reports (Big Slice 4)

This document defines how a business date is closed and reopened, what a close blocks, how backdating works, and exactly how every report figure is produced. All amounts are integer dirham in the database (QAR × 100). Executed evidence is in [daily-close-reports-verification.md](daily-close-reports-verification.md).

Migration: `supabase/migrations/20261004090000_daily_close_and_reports.sql`.

## 1. Close and reopen

### Model

`public.daily_closes` is an append-only event log, one row per decision:

| Column | Meaning |
| --- | --- |
| `shop_id`, `business_date` | What was closed or reopened. Each shop closes independently. |
| `event_type` | `closed` or `reopened`. |
| `event_sequence` | Identity column. The event with the highest sequence for a shop/date is its current state. |
| `actor_id`, `recorded_at` | Who decided, and when. |
| `note` | Optional text on a close (1–2000 characters). Only a close may carry it. |
| `reason` | Mandatory, non-blank text on a reopen. A close never has one. |

A date with no events, or whose latest event is `reopened`, is open. Nothing is ever updated or deleted: the table has an append-only trigger, `UPDATE`/`DELETE`/`INSERT` are revoked from application roles, and a reopen is a new row, so the fact that the day was closed stays visible. Every close and reopen also writes an `audit_events` row (`date.close` / `date.reopen`, entity `business_date`) carrying the actor, the note or reason, and the day's summary figures as they stood at that moment.

### RPCs

`close_business_date({shop_id, business_date, note?})` and `reopen_business_date({shop_id, business_date, reason})`. Both are `SECURITY DEFINER`, derive the actor from `auth.uid()`, and are the only way to write a close event.

| Check | Error |
| --- | --- |
| Not signed in, or inactive profile | `AUTHENTICATION_REQUIRED` |
| Malformed command, unknown field, text over 2000 characters | `INVALID_REQUEST` |
| No access to the shop | `UNAUTHORIZED_SHOP` |
| Role is not manager or owner | `INSUFFICIENT_ROLE` |
| Reopen without a non-blank reason | `REASON_REQUIRED` |
| Date after the current Qatar date | `INVALID_DATE` |
| Manager reopening a date other than the current Qatar date | `INSUFFICIENT_ROLE` |
| Close of an already closed date | `ALREADY_CLOSED` |
| Reopen of a date that is not closed | `NOT_CLOSED` |

Close and reopen are state transitions, not retried commands, so they take no idempotency key: a repeated close answers `ALREADY_CLOSED` and the screen shows the state the server holds.

### Permissions

| Action | Staff | Manager | Owner |
| --- | --- | --- | --- |
| See close state, summary and history for an assigned shop | Yes | Yes | Yes (all shops) |
| Close a date (today or earlier) | No | Assigned shops | All shops |
| Reopen the current Qatar date | No | Assigned shops | All shops |
| Reopen an earlier date | No | No | All shops |

The product specification gives the manager a reopen right "limited by permission". This slice fixes that limit as: a manager can reopen only the current date. A manager cannot write to an earlier date at all (backdating is owner-only), so reopening one would only serve an owner. This is a decision made in this slice, not a rule that was already written down; change `private.record_day_close_event` and `canReopenDate` together if it should differ.

### What blocks a close

Only the date rule (no future date). Nothing else blocks:

- A draft or queued batch on someone's device is not server state and cannot block a close. The server does not know it exists.
- Undecided correction and replacement requests do not block. The close screen counts them for the selected date so the person closing can decide first.
- There is no half-committed financial operation to wait for: every write is one transaction.

## 2. What a closed date blocks

The rule is enforced in the database, on the tables themselves. A `BEFORE INSERT` trigger on `invoices`, `payments`, `corrections`, `customer_credits`, `credit_applications` and `expenses` raises `CLOSED_DATE` when the row's `(shop_id, business_date)` is closed. A seventh trigger on `expense_correction_decisions` applies the same rule to the business date of the expense being corrected when the decision is `approved`. Any RPC, present or future, that writes a dated financial row is therefore covered; the checks that already existed inside the RPCs remain and fail earlier with the same error.

| Path | Date checked | Closed result |
| --- | --- | --- |
| `submit_batch` (manual, Excel import, offline replay) | batch business date | `CLOSED_DATE`, nothing written |
| `record_payment` | payment business date | `CLOSED_DATE` |
| `record_customer_payment` | current Qatar date | `CLOSED_DATE` |
| `apply_customer_credit` | current Qatar date | `CLOSED_DATE` |
| `approve_overpayment` | payment business date | `CLOSED_DATE` |
| `create_expense` | expense business date | `CLOSED_DATE` |
| `decide_invoice_correction` (approve) | current Qatar date (the correction's own date) | `CLOSED_DATE` |
| `decide_expense_correction` (approve) | the expense's business date | `CLOSED_DATE` |
| Any decision `rejected`; any `request_*`; `decide_invoice_replacement`; `create_customer`; `register_expense_attachment` | — | Allowed: none of them changes a day's totals |

The owner is bound by a close like everyone else.

**No write can slip in during a close.** Every insert takes a shared advisory lock on its shop/date and holds it until its transaction commits; a close takes the exclusive lock for the same key. A write in flight finishes before the close is recorded, and a write that starts after it sees the close.

### Corrections and closed periods

- **Invoice and payment corrections** are separate rows dated on the day they are approved (existing rule, `docs/invoice-operations.md`). Approving one needs *that* day to be open. It appears in that day's summary as a correction line and leaves the original, possibly closed, day's summary untouched.
- **Expense corrections** have no row of their own: an approval replaces the amount reported under the expense's business date. Approving one therefore needs the expense's date to be open. If it is closed, reopen it with a reason, approve, and close again.
- **Replacements** change invoice number, customer or delivered flag only. They move no money and are allowed on a closed date.

A closed day's daily summary (section 4) cannot change until the day is reopened.

### Exact retries after a close

Every financial RPC resolves an exact retry (same shop, same idempotency key, same content) before it applies any date rule, and a retry inserts nothing, so no trigger fires. A transaction that committed while the date was open and whose response was lost returns its original stored result after the date has closed. The same key with different content is still `IDEMPOTENCY_CONFLICT`. `approve_overpayment` previously checked the close before the retry; this slice moves the check after it.

## 3. Backdated entry

| Path | Who | Reason |
| --- | --- | --- |
| Invoice batch (`submit_batch`, manual and Excel) | Owner only | `is_backdated: true` and `backdated_reason`, stored on `batches` |
| Expense (`create_expense`) | Owner only | `backdated_reason`, stored on `expenses` and in the audit event |
| Follow-up payment (`record_payment`) | Owner only | `backdated_reason`, required from this slice, stored in the audit event (`reason`, `metadata.is_backdated`, `metadata.business_date`) |
| Overpayment approval (`approve_overpayment`) | Owner only | The mandatory approval `reason` |
| Customer payment, credit application, correction approvals | Nobody | Always the current Qatar date |

Rules that hold on every path: staff and managers cannot backdate; a future date is rejected; a reason is mandatory; a reason on a current-date payment is rejected; a closed date stays blocked until an owner reopens it with a reason.

The backdate reason on `record_payment` is audit data and is not part of the payment fingerprint, so payments recorded before this slice remain exactly replayable. The app's payment screens always use the current date; a backdated follow-up payment is available through the RPC only.

A record's **business date** is the day it belongs to in reports. Its **recorded timestamp** (`recorded_at`) is when it was entered and never changes. Screens show both: the close screen lists the backdated batches and expenses of the selected date with their reason, actor and recorded time, and every report shows the business date next to the Qatar-local recorded time.

An offline draft cannot turn into an unauthorized backdated batch. A draft that was following "today" moves to the current date when restored on a later day; the server compares the submitted date with the current Qatar date and rejects a current-date batch that has become an earlier date (`STALE_DATE` in the app, role and reason checks in the RPC).

## 4. Daily summary

`report_daily_summary(shop, from, to)` returns one row per business date that has activity (at most 366 days per call; a day with no activity has no row and every figure is zero). Every source row is selected by its own `business_date`.

| Metric | Formula |
| --- | --- |
| Invoices entered | count of `invoices` dated D |
| Gross invoice amount | Σ `invoices.total_amount_dirham` dated D (original totals) |
| Received at entry | Σ `payments.amount_dirham` dated D with `batch_id` set |
| Due created at entry | gross invoice amount − received at entry |
| Follow-up invoice payments | Σ `payments.amount_dirham` dated D with no `batch_id` and no `customer_payment_batch_id` (includes the applied part of an approved overpayment) |
| Customer payments | Σ `payments.amount_dirham` dated D with `customer_payment_batch_id` set |
| Payment corrections | Σ `corrections.amount_delta_dirham` dated D, approved, `payment_id` set |
| Invoice corrections | Σ `corrections.amount_delta_dirham` dated D, approved, `invoice_id` set |
| Overpayment kept as customer credit | Σ `customer_credits.amount_dirham` dated D, approved |
| Customer credit applied (not a receipt) | Σ `credit_applications.amount_dirham` dated D |
| Expenses recorded / Expenses | count and Σ `effective_expenses.amount_dirham` dated D (latest approved correction) |
| Cash received | the part of (received at entry + follow-up payments + customer payments + payment corrections + overpayment kept as credit) recorded as **cash** |
| Bank received | the part of the same receipts recorded as **bank** |
| Total received | cash received + bank received |
| Net movement | total received − expenses |
| Net change in outstanding due | gross invoice amount + invoice corrections − received at entry − follow-up payments − customer payments − payment corrections − credit applied |

Payment methods are **Cash** and **Bank**. "Received at entry", "Follow-up invoice payments", "Customer payments", "Payment corrections" and "Overpayment kept as customer credit" count receipts of either method; they never mentioned cash in their labels and still do not. A payment correction or an overpayment credit follows the method of the payment it belongs to. Expenses carry no method. Customer credit applied is not a receipt and is in neither Cash nor Bank.

**No figure is profit.** ShopKhata records sales, receipts, dues and expenses. It has no cost of goods, so it reports no profit, margin, COGS or income statement. "Net movement" is total received (cash and bank) minus expenses and is labelled as such everywhere. It was previously labelled "Net cash movement"; with no bank receipts the figures are identical.

Summed over all dates, "net change in outstanding due" equals the total effective due of all invoices: it uses exactly the terms of `invoice_effective_balances.effective_due_dirham`.

## 5. Reports

Screen: `/reports?shop=…&report=daily|sales|dues|expenses|payments`. Anyone who can view a shop's records can view its reports; exports need `records.export`. Row lists on screen stop at 200 rows; the totals always cover every row, and the export contains all rows (cap 20,000).

| Report | Filter | Rows | Totals |
| --- | --- | --- | --- |
| Daily summary | shop, business date | — | `report_daily_summary` |
| Sales by invoice date | shop, date range | `effective_invoices` whose `business_date` is in range | `report_sales_totals`: count, Σ effective total, Σ effective paid, Σ credit applied, Σ effective due, delivered / not delivered counts |
| Customer dues | shop | `customer_financial_balances` with due > 0 or credit > 0, with customer name, mobile, invoice count, latest activity date | `report_customer_due_totals`: customers with due, Σ outstanding due, Σ available credit, due on invoices without a customer |
| Expenses | shop, date range | `effective_expenses` in range with category, creator, recorded time, backdate reason, and whether a correction was applied | `report_expense_totals`: per category and overall |
| Payments | shop, date range | `report_payments` in range | `report_payment_totals`: per type, total cash, total bank, total credit applied |

Two reports answer different questions and are not expected to show the same number:

- The **daily summary** is what was recorded *for a day*. It does not change once the day is closed.
- **Sales by invoice date** is the *current* position of the invoices dated in a range: later payments, credit and approved corrections are included, whatever day they happened on. A replaced invoice is one row under its current number, with its original number beside it.

`report_payments` has one row per source record:

| Type | Source | Method |
| --- | --- | --- |
| Received at invoice entry | `payments` with `batch_id` | cash or bank |
| Follow-up invoice payment | `payments` with neither batch | cash or bank |
| Customer payment | `payments` with `customer_payment_batch_id` | cash or bank |
| Payment correction | approved `corrections` with `payment_id`, on the correction's date, signed | that of the corrected payment |
| Overpayment kept as credit | approved `customer_credits` | the method recorded on the credit |
| Customer credit applied | `credit_applications` | credit (not cash) |

Reports never recompute money in the application. `lib/reports.ts` maps database rows to labels and passes amounts through; a value that is not a safe integer is refused rather than rounded.

## 6. Reconciliation rules

Each of these is asserted in `supabase/tests/daily_close_reports.test.sql` and again against real sessions in `tests/integration/closing-reports.test.ts`.

1. Customer due report total = Σ `customer_financial_balances.outstanding_due_dirham` for the shop.
2. Customer due total + due on invoices without a customer = Σ `effective_invoices.effective_due_dirham` for the shop.
3. Sales report totals = the same sums over `effective_invoices` for the same shop and date range.
4. Expense report total = Σ `effective_expenses.amount_dirham` for the same filter = Σ of its category totals = "Expenses" in the daily summary.
5. Cash rows of the payment report for a date = "Cash received" in the daily summary; bank rows = "Bank received"; credit rows = "Customer credit applied". Cash + bank = "Total received".
6. For one invoice, its payment and payment-correction rows across all dates add up to its `effective_paid_dirham`.
7. A credit application is one row; an approved correction is one row; a pending or rejected request is no row.
8. A replaced invoice is one canonical row; its earlier number produces no second row.
9. When all activity on a set of invoices falls on one day, that day's net change in outstanding due = the effective due left on those invoices. Over all dates, the net changes add up to the shop's total effective due.

## 7. Qatar dates

The business date is the Asia/Qatar calendar date (UTC+3, no daylight saving). From 00:00 to 03:00 Qatar time the UTC calendar date is one day behind, so the UTC date is never used.

- Database: "today" is `(now() at time zone 'Asia/Qatar')::date` in every RPC, including close and reopen. It does not depend on the session time zone.
- Application: `qatarBusinessDate(new Date())`. Business dates travel as `YYYY-MM-DD` text and are compared as text; they are never converted through a time zone.
- Reports group by the stored `business_date`, never by `recorded_at`. Recorded times are displayed in Qatar time.

## 8. Offline drafts and closed dates

A draft on a device is never server state.

- **Prepared before a close, sent after it.** The server answers `CLOSED_DATE`. Nothing is written — no batch, invoice, payment or customer. The device shows "This business date is closed…", marks the draft "Conflict — not saved to ShopKhata", and keeps every row, the date and the backdate reason. After a reopen the same draft saves once.
- **Committed before a close, response lost.** The device retries with the same key and payload and receives the original receipt, although the date is now closed. Nothing is written twice.
- A pending draft never blocks a close and is never counted in a summary.

## 9. Excel exports

`/exports/report-daily|report-sales|report-expenses|report-payments?shop=…&from=…&to=…` and `/exports/report-dues?shop=…`, linked from each report as "Export this report (.xlsx)". They use the same fetch functions and the same database totals as the screen, through the caller's own RLS-scoped session, so a shop the user cannot see yields 403 from the route and no rows from the database.

| Sheet | Columns | Closing rows |
| --- | --- | --- |
| Daily summary | Business Date, then one column per metric in section 4 order | one row per date |
| Sales | the invoice export columns | Total |
| Customer dues | Customer ID, Customer, Mobile, Outstanding Due, Available Credit, Invoices, Last Activity | Total; Due on invoices without a customer |
| Expenses | Business Date, Category, Description, Amount, Correction State, Created By, Recorded At (Qatar), Backdate Reason, Expense Reference | one total per category; Total |
| Payments | Business Date, Recorded At (Qatar), Type, Method, Amount, Invoice Number, Customer, Reference | one total per type; Total cash received; Total bank received; Total received (cash + bank); Total customer credit applied |

### Export contract: Cash and Bank

Workbooks are positional (column order is part of the contract), so every change made when Bank was added is listed. Money columns are named `… QAR` in the file. Sheet names, file names, the invoice, ledger, expense, customer-dues and sales exports and the Excel import template did not change.

**Daily summary** (`shopkhata-report-daily-{from}_{to}.xlsx`, sheet `Daily summary`), 16 columns before, 18 now:

| # | Column | Change |
| --- | --- | --- |
| 1–13 | Business Date … Expenses QAR | unchanged |
| 14 | Cash received QAR | unchanged position; now cash only |
| 15 | Bank received QAR | **new** |
| 16 | Total received QAR | **new** (cash + bank) |
| 17 | Net movement (total received − expenses) QAR | was column 15, "Net cash movement (cash received − expenses) QAR"; renamed and moved |
| 18 | Net change in outstanding due QAR | was column 16; moved, unchanged |

A reader that picks columns by position must read "Net movement" and "Net change in outstanding due" two columns to the right. Before any bank receipt exists, Cash received = Total received = the former Cash received, and Net movement = the former Net cash movement.

**Payments** (`shopkhata-report-payments-{from}_{to}.xlsx`, sheet `Payments`): the eight columns and their order are unchanged. `Method` (column 4) already existed and holds the stored lower-case value: `cash`, `bank` (new), or `credit` for an applied customer credit. Rows recorded before Bank existed all read `cash`. The closing rows are now: Total cash received, **Total bank received**, **Total received (cash + bank)**, Total customer credit applied; "Total cash received" no longer includes bank.

**Excel import** (`shopkhata-invoice-import-template.xlsx`) has no payment-method column and is unchanged: every amount in `Received QAR` is imported as Cash, as before. Bank receipts are entered in the app, not by import.

Money cells are numbers in QAR with two decimals. The existing invoice, ledger and expense exports are unchanged.

## 10. Performance

Reports filter by shop and business date. Indexes added for exactly those filters: `invoices`, `payments`, `credit_applications`, `batches` on `(shop_id, business_date)`; `corrections` and `customer_credits` on the same columns for approved rows; `daily_closes (shop_id, business_date, event_sequence desc)` for the close-state lookup that every write performs. `expenses` already had one. With sequential scans disabled, each report query resolves its date filter through these indexes.

Totals are computed by one SQL function per report. Row lists are paged (200 on screen, 500 per page for exports); customer and invoice names are looked up in batches of 200 ids, not per row. The customer due report reads `customer_financial_balances` for the whole shop; that projection is not date-bounded by nature and is the one to revisit if a shop grows to many thousands of customers.

## 11. Limitations

- Reports are per shop. There is no combined two-shop owner report.
- A backdated follow-up payment has no screen; it is RPC-only.
- The entry screens do not show a "closed" banner in advance; the server rejects the save and the screen explains why.
- A multi-day daily-summary export has one row per day and no grand-total row.
- Customer dues is a current position; there is no "as of date" view.
