# ShopKhata Product Design Specification

**Status:** Approved design awaiting written-spec review  
**Date:** 2026-08-25  
**Source reference:** `ShopKhata.xlsx`  
**Product boundary:** Standalone product; no connection to Mahira ERP

## 1. Purpose

ShopKhata is a focused two-shop financial operations web application. It replaces the daily Excel workflow for bulk invoice entry, advances, deliveries, readymade sales, partial payments, customer dues, customer credits, expenses, attachments, daily closing, and owner reporting.

ShopKhata is not an ERP. Version 1 excludes inventory, purchasing, suppliers, payroll, general-ledger accounting, AI/OCR, WhatsApp automation, native mobile applications, and Mahira ERP integration.

## 2. Product goals

1. Enter a full shop-day invoice batch in an Excel-like grid instead of saving invoices one at a time.
2. Preserve a reliable payment and due history for every invoice.
3. Support the same manually assigned invoice ID in different shops while preventing duplicates within one shop.
4. Support offline entry without silently overwriting newer server data.
5. Keep sales, cash received, customer dues, customer credits, and expenses distinct.
6. Provide individual accountability through user accounts, approvals, corrections, and audit history.
7. Start on free infrastructure while retaining clear export, backup, and migration paths.

## 3. Users, shops, and access

### 3.1 Shops

Version 1 supports Shop 1 and Shop 2. Each entry session is locked to one selected shop. Staff do not select the shop on every row.

### 3.2 Roles

| Action | Shop Staff | Manager | Owner/Admin |
|---|---:|---:|---:|
| Enter batches for assigned shop | Yes | Yes | Yes |
| Record partial payments | Yes | Yes | Yes |
| Create expenses | Yes | Yes | Yes |
| Deliver an invoice with customer due | Yes | Yes | Yes |
| View assigned-shop records | Yes | Yes | Yes |
| View both shops and combined totals | No | Assigned only | Yes |
| Override excess payment | No | Yes | Yes |
| Approve corrections/reversals | No | Yes | Yes |
| Close a business date | No | Yes | Yes |
| Reopen a closed date | No | Limited by permission | Yes |
| Manage users and shop assignments | No | No | Yes |
| Export records | Limited | Assigned shops | All shops |
| Import Excel batches | Assigned shop | Assigned shops | All shops |
| View full audit history | No | Assigned shops | All shops |

Every staff member has an individual login. Server and database authorization enforce shop boundaries; hiding interface elements is not considered security.

## 4. Core records

| Record | Responsibility |
|---|---|
| Shop | Business location and security boundary |
| User | Login, role, status, and assigned shops |
| Customer | System-generated customer ID plus optional name and mobile |
| Batch | One shop, one business date, creator, rows, and synchronization state |
| Invoice | Sale identity, quantity, type, total, delivery state, and optional customer |
| Payment | Immutable full or partial payment linked to one invoice |
| Customer credit | Approved excess payment available for future use |
| Expense | Shop, date, description, amount, creator, and optional attachment |
| Attachment | Image linked to a batch or an individual invoice |
| Correction | Reversal or adjustment linked to the original record |
| Daily close | Lock for one shop and one business date |
| Audit event | Actor, action, time, reason, and relevant before/after references |

Financial history is event-based. A later payment or correction creates a new record; it does not rewrite the original financial event.

## 5. Identifiers

### 5.1 Invoice identity

The user enters the invoice ID. It is stored as text so IDs such as `8704` and `A-8704` remain valid.

The unique invoice key is:

`(shop_id, invoice_id)`

Therefore, Shop 1 invoice `8704` and Shop 2 invoice `8704` may coexist. A second new Shop 1 invoice `8704` is a duplicate and is blocked.

### 5.2 Customer identity

The system automatically assigns permanent customer IDs such as `CUS-00001`. Customer name and mobile number are optional. The system ID is always required and immutable.

## 6. Invoice types and lifecycle

### 6.1 Advance

An Advance invoice represents an order with a total and an initial amount received. It may retain an outstanding balance. Customer selection is optional until the order is delivered with a remaining due.

### 6.2 Delivery

Delivery may occur with a zero or non-zero balance:

- Zero balance: `Delivered – Paid`.
- Remaining balance: `Delivered – Due`; selecting a customer is mandatory.

### 6.3 Readymade

Readymade is immediately treated as delivered:

- Fully paid: customer optional.
- Partially paid or unpaid: customer mandatory and remaining balance becomes customer due.

## 7. Payments, dues, and credits

### 7.1 Partial payments

Re-entering an existing invoice ID as a payment does not create another invoice. It creates a payment linked to the original invoice.

Example:

- Invoice due: QAR 1,000.00.
- Payment: QAR 400.00.
- Remaining due: QAR 600.00.
- Later payment: QAR 600.00.
- Final state: Paid.

### 7.2 Overpayment

If a payment exceeds the current invoice due:

1. Ordinary staff cannot finalize it directly.
2. The interface shows current due, entered payment, and excess.
3. Manager/Owner approval and a reason are required.
4. A customer must be selected because the excess cannot become anonymous credit.
5. The invoice is settled only up to its due.
6. The excess becomes credit for the selected customer.
7. Staff member and approver are recorded separately.

Overpayment never increases the original invoice total and never leaves an unassigned financial amount.

### 7.3 Balance calculation

Invoice due is derived from the invoice total, valid payments, applied credits, and approved corrections. Customer due and customer credit are derived from their underlying records. Cached balances may be used for performance but are not independent financial truth.

All QAR amounts support two decimal places. More than two decimal places are rejected. Financial calculations use exact decimal arithmetic, not binary floating-point arithmetic.

## 8. Bulk-entry workflow

1. Staff select their assigned shop.
2. Staff select the business date.
3. The app opens an Excel-like grid.
4. Staff type or paste multiple invoice/payment rows.
5. Keyboard flow prioritizes rapid Tab/Enter movement.
6. The grid calculates row and batch totals immediately.
7. The app validates every row locally.
8. Online server validation checks permissions, duplicates, current balances, customer requirements, and date closure.
9. Any blocking error prevents the entire batch from saving.
10. Errors are shown on their exact rows and cells.
11. After every row passes, the server commits the full batch atomically.
12. The batch receives a unique batch ID and audit record.

The app never silently saves only the valid subset of a submitted batch.

## 9. Attachments

Users may photograph or upload handwritten pages and other evidence. An attachment may belong to:

- the complete daily batch; or
- an individual invoice.

The app provides preview, optional note, safe image compression, upload state, and missing-upload visibility. Handwriting recognition and automatic form population are excluded from Version 1.

## 10. Expenses

An expense records shop, business date, description, QAR amount, creator, and optional attachment. Expenses are separate from invoice and payment records.

Daily reporting shows expenses independently and calculates net cash result as money received minus expenses. Net cash result is not profit.

## 11. Offline operation and synchronization

### 11.1 Local operation

- The installable web application caches the interface and relevant assigned-shop data.
- IndexedDB stores offline drafts and a synchronization outbox.
- Offline batches are marked `Pending sync`, not server-confirmed.
- Staff may edit a pending batch until synchronization begins.
- Photos remain queued on the originating device until uploaded.
- A pending batch cannot be used to close a day.

### 11.2 Synchronization protocol

1. The device uploads the complete batch with a stable idempotency key.
2. The server verifies the authenticated user, role, shop access, and business date.
3. The server validates every invoice ID and current referenced-invoice version.
4. The server validates current due, customer requirements, overrides, and closed-date state.
5. If every row passes, the server commits the batch once.
6. If any row fails or conflicts, no row is committed.
7. Retrying the same idempotency key returns the existing result rather than duplicating data.

### 11.3 Conflict handling

- Two offline devices create the same shop/invoice ID: first valid synchronization succeeds; second becomes a conflict.
- An offline payment references a stale due: synchronization rejects it for review.
- A date closes while a device is offline: pending entries for that date are blocked unless the date is reopened.
- A user's access is revoked while offline: synchronization is rejected.

There is no last-write-wins behavior for financial records. The server is authoritative, and conflicts require explicit review.

## 12. Corrections and immutable history

Before submission, staff may freely edit draft rows. After submission:

- direct overwrite and deletion are prohibited;
- staff may request a correction;
- an authorized Manager/Owner approves a reversal or adjusting entry;
- a reason is required;
- original and correcting records remain visible.

## 13. Daily closing

Each shop closes independently by business date.

1. Staff finish and review daily entries.
2. All pending offline entries on known devices must synchronize or be explicitly accounted for.
3. Manager/Owner closes the date.
4. Ordinary entries for that shop/date are blocked.
5. Reopening requires permission and a reason.
6. Close and reopen actions appear in audit history.

Because an unknown offline device may still contain a pending batch, closing is a server lock, not proof that no future conflict will appear. A later stale batch is rejected rather than silently inserted.

## 14. Backdated entry

Owner/Admin may record missed transactions against a previous business date. The system keeps two distinct timestamps:

- **Business date:** the date on which the transaction actually belongs in operational reports.
- **Recorded date/time:** the immutable timestamp at which the user entered the record into ShopKhata.

Backdated-entry rules:

1. Only Owner/Admin may create a backdated batch.
2. The user selects one shop and one previous business date before entering the batch.
3. A reason for late entry is mandatory.
4. The interface and audit history display a clear `Backdated` label.
5. Future business dates are prohibited.
6. If the selected shop/date is closed, Owner/Admin must explicitly reopen it with a reason, enter and review the batch, and close it again.
7. Backdated invoices, payments, expenses, corrections, and daily totals appear under their business date; audit reports retain their actual recorded date/time and actor.
8. Different business dates may not be mixed inside one manual batch.

An administrator entering several missed days in one sitting creates a separate atomic batch for every `(shop, business_date)` group. A multi-date Excel file may be uploaded for convenience, but the server splits it into independent shop/date batches, validates every group, and reports success or failure per group. One date's failure does not silently alter another date's batch.

## 15. Excel import and export

### 14.1 Import

- Provide a fixed downloadable template.
- Select shop and business date before import.
- Standard imports use the selected shop and business date for every row.
- Owner/Admin may use the controlled multi-date backdated-import template; the server groups its rows into separate atomic `(shop, business_date)` batches.
- Treat invoice IDs as text.
- Apply the same validation, authorization, atomicity, override, and closed-date rules as the manual grid.
- Reject the complete file if any blocking error exists.
- Show row and column error locations.

### 14.2 Export

Exports include:

- daily batch;
- shop/date range;
- invoices and delivery states;
- payments;
- customer dues and credits;
- expenses;
- audit and correction history for authorized users;
- combined owner report.

## 16. Screens

1. Login
2. Daily bulk entry
3. Pending offline batches
4. Invoice search and history
5. Customer list and ledger
6. Payments
7. Expenses
8. Daily review and close
9. Excel import/export
10. Conflict review
11. Corrections and approvals
12. Owner dashboard
13. Staff and shop management
14. Audit history
15. Backdated entry and late-entry review

Desktop/tablet bulk entry uses an Excel-like grid. Phone entry uses compact invoice cards. High-volume entry is intentionally optimized for computers and tablets.

## 17. Reporting definitions

The dashboard separates:

- invoice sales total;
- money received;
- outstanding invoice due;
- customer due;
- customer credit;
- expenses;
- net cash result (money received minus expenses);
- pending synchronization count;
- unclosed business dates.

Reports may show Shop 1, Shop 2, or combined totals according to permission. Invoice sales and money received must never share a misleading label.

Operational reports group transactions by business date. Audit and late-entry reports show both business date and actual recorded date/time.

## 18. Technical architecture

### 17.1 Selected stack

- Frontend: Next.js with TypeScript and React.
- Delivery: installable Progressive Web App.
- Backend: Supabase-managed PostgreSQL, authentication, and object storage.
- Offline data: IndexedDB through Dexie.
- Synchronization: custom append-only outbox and server-authoritative validation.
- Hosting: free plans initially.

### 17.2 Security

- Database constraints enforce invoice uniqueness per shop.
- Row-level security enforces assigned-shop access.
- Server-side functions own financial commands and atomic batch commits.
- Client calculations are previews only; the server recalculates authoritative results.
- Sensitive approvals require fresh authorization where practical.
- Attachments use non-public storage and authorized access.

### 17.3 Free-plan constraint

Free infrastructure is a starting constraint, not a reliability guarantee. The design must permit provider migration and must not depend on proprietary client behavior for financial correctness.

## 19. Error behavior

Errors are divided into:

- Field errors: invalid/missing values shown at the cell.
- Batch errors: one or more rows prevent atomic commit.
- Permission errors: action not authorized.
- Conflict errors: server data changed since local data was read.
- Sync errors: temporary transport or service failure; safe retry uses the same idempotency key.
- Override-required warnings: authorized approval and reason are needed.

No error path may silently drop a row, duplicate a payment, produce a negative due, or reclassify excess money without approval.

## 20. Verification and acceptance tests

The implementation is not production-ready until automated and manual tests prove:

1. Same invoice ID in different shops is accepted.
2. Duplicate new invoice ID within one shop is blocked.
3. Multiple partial payments calculate the correct remaining due.
4. Overpayment without approval is blocked.
5. Approved overpayment settles the invoice and creates exact customer credit.
6. Delivered/Readymade invoice with due and no customer is blocked.
7. Anonymous fully paid invoice is accepted.
8. One invalid row rejects the complete batch.
9. Retrying a batch does not duplicate records.
10. Two offline devices creating the same shop/invoice ID produce one success and one reviewable conflict.
11. Concurrent payments cannot produce a negative balance.
12. Entries against a closed date are blocked.
13. Corrections preserve original records.
14. Unauthorized cross-shop reads and writes fail at the database boundary.
15. Excel import follows the same validation rules.
16. Amounts remain exact to two decimal places.
17. Missing or failed image uploads remain visible and retryable.
18. Dashboard definitions reconcile to underlying invoice, payment, credit, and expense records.
19. A permitted backdated batch appears under its business date and retains its later recorded timestamp.
20. A future-dated batch is blocked.
21. A backdated batch against a closed date requires an explicit reopen and reason.
22. Multi-date import creates separate atomic shop/date batches and reports each group's result.

## 21. Backup and recovery

- Owner may export all records to Excel at any time.
- Daily exports are organized by shop and business date.
- Full backups include customer ledgers, payments, credits, corrections, and audit records.
- Database dumps are stored outside the hosting account regularly.
- Attachments are included in a separate recoverable backup process or manifest.
- The owner dashboard shows the latest successful backup date.
- Restore procedures must be tested before production use.

Free hosting is not treated as a backup strategy.

## 22. Explicit Version 1 exclusions

- Inventory and stock quantities
- Product catalogue
- Purchases and suppliers
- Accounting general ledger
- Payroll
- AI/OCR handwriting extraction
- WhatsApp automation
- Native Android/iPhone application
- Mahira ERP integration
- Decorative animation and nonessential analytics

## 23. Implementation gate

Implementation may begin only after the user reviews and approves this written specification. The next artifact after approval will be a phase-based implementation plan with verification gates. No production code is authorized by approval of the design alone.
