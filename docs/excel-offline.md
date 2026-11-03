# Excel import/export and offline reliability — BIG SLICE 3

Implemented on `phase-3-operational-ui`, starting from `d14e6ef005a20ff3735e82f4ee76ec936b1acc57`. The Product Design Specification (§11, §15) remains the governing authority. This document describes what the slice does and, as importantly, what it does not do. Executed results are in [excel-offline-verification.md](excel-offline-verification.md).

One rule runs through everything below: **the server is the only financial truth.** A draft, a queued submission and a cached page are local conveniences. Nothing in the browser is ever described as saved until `submit_batch` has returned a confirmed receipt.

## 1. Excel invoice import

Import does not have its own save path. A workbook is parsed in the browser into the same draft rows that typing produces (`EntryRow`), and from there everything is shared: `prepareInvoiceBatch` validation, the Review batch step, the `saveInvoiceBatch` server action and the `submit_batch` RPC. Choosing a file commits nothing.

### Schema

The sheet must be named `Invoices` (or be the only sheet). Row 1 holds exactly these headers, in this order. Header matching ignores case and surrounding spaces.

| Column | Required | Accepted values |
| --- | --- | --- |
| Invoice Number | yes | Text, or a whole number. Format the cell as Text to keep leading zeros. |
| Total QAR | yes | Number or text, greater than zero, at most two decimals. |
| Received QAR | no | Blank (treated as 0), or zero up to the total, at most two decimals. Imported as Cash; the template has no payment-method column. |
| Delivered | no | `Yes`/`No`, `Y`/`N`, `TRUE`/`FALSE`, `1`/`0`, or a boolean cell. Blank means No. |
| Customer Name | no | Text. Creates a quick-add customer, exactly as typing a new customer name does. |
| Customer Mobile | no | Text or digits. |
| Note | no | Text, up to 1000 characters. |

Shop and business date are not columns. They come from the workspace, so a file can never place rows in another shop or mix dates in one batch. The owner-only multi-date template in the specification is not part of this slice.

Money is never rounded. A numeric cell with at most two decimals becomes an exact decimal string; anything else is passed through unchanged so the shared `parseQar` validation rejects it.

### What is rejected

File-level problems reject the whole file and show no preview: a file that is not `.xlsx`, larger than 1 MB, or unreadable; a missing, duplicated, unknown, blank or out-of-order header; no data rows; more than 100 rows. Rows are never truncated.

Row-level problems are listed against their spreadsheet row number and block the import: an unsupported cell type, values outside the template columns, an invalid Delivered value, and every rule manual entry enforces (invalid or non-positive total, negative or excessive received, missing invoice number, delivered-with-due without a customer, a number duplicated inside the file, a number already registered in the shop). While any error is listed, no row can be added to the draft. Fix the workbook and import again.

Fully blank rows are skipped; the reported row numbers still match the spreadsheet.

### Flow

1. Choose an `.xlsx` file, or paste cells copied from Excel (tab-separated, template column order, header optional).
2. The preview lists the rows and any errors. It states that nothing is saved.
3. With a blank draft, **Add rows to draft**. With rows already in the draft, choose **Add to current draft** or **Replace current draft**. Merging is validated against the existing rows and capped at 100 rows.
4. Imported rows are ordinary draft rows with stable row IDs. They can be edited, removed, reviewed and saved like any others.

**Download template** produces `shopkhata-invoice-import-template.xlsx`: an empty `Invoices` sheet with the headers, and an `Instructions` sheet with the rules and three fictional example rows. The template is generated in the browser and works offline.

The existing customer search is the way to link a row to an existing customer; the file itself carries only a new customer's name and mobile.

## 2. Excel export

Exports are `.xlsx` files produced by `GET /exports/{invoices|customer-ledger|expenses}`. Each request authenticates the caller, requires `records.export` for the named shop, and reads through the caller's own RLS-scoped session. Naming another shop returns 403; an unknown customer returns 404; no session leads to the login page. Responses are `no-store`.

Money is exported as QAR numbers with a two-decimal format, converted from integer dirham; a value that is not a whole number of dirham aborts the export rather than being written. Dates are `YYYY-MM-DD` business dates; recorded times are Qatar local time.

| Export | Where | Columns |
| --- | --- | --- |
| Invoices | Workspace → Recent invoices, date range | Invoice Number, Business Date, Current Total QAR, Paid QAR, Credit Applied QAR, Due QAR, Delivered, Customer, Customer Mobile, Recorded At (Qatar), Original Number, Invoice Reference, Status (ACTIVE / VOID), Original Total QAR. A current-state register of the invoices dated in the range: a voided invoice shows Current Total 0 and Status VOID, and its Original Total keeps the amount recorded on its date. For what happened on each date (sales, corrections and voids as movements) export the Sales report. |
| Customer ledger | Customer page | Business Date, Type, Reference, Invoice Number, Debit QAR, Credit QAR, Balance QAR, Recorded At (Qatar) |
| Expenses | Expenses page, date range | Business Date, Category, Description, Amount QAR, Created By, Recorded At (Qatar), Expense Reference |

Cash and Bank (payment methods) change only the report exports; these three exports and the import template are unchanged. "Paid QAR" is paid by either method. See [daily-close-reports.md](daily-close-reports.md#export-contract-cash-and-bank) for the report column order.

Values are the effective ones users see, not stale originals:

- Invoices read `effective_invoices`: the current invoice number, customer and delivery state after approved replacements, and total/paid/due after approved corrections. The original number and the canonical invoice UUID are included for traceability.
- The customer ledger reads `customer_ledger` and uses the same `mapCustomerLedger` ordering and running balance as the customer screen, so the last balance equals `customer_financial_balances`.
- Expenses read `effective_expenses`, which carries the latest approved correction. Created By is the creator's display name where RLS lets the caller read it, otherwise the creator's ID.

An export of more than 20,000 rows is refused with a request to shorten the range.

## 3. Durable drafts

The entry workspace keeps the unsaved batch in IndexedDB through Dexie (database `shopkhata-local`, schema version 1, tables `drafts` and `meta`). It survives a reload, a closed tab and a lost connection.

Stored per draft: user ID, shop ID, business date and the day it was saved, backdate reason, rows with their stable row IDs, the customers linked to those rows (ID, name, mobile, public ID — needed to show which customer a row points at), the idempotency key, any queued submission, the last conflict message, and created/updated timestamps. Nothing else. No token, password, session or balance is stored.

Rules:

- There is one draft per user per shop. The key is `userId:shopId`.
- The draft is written on every change and removed when it becomes empty. After a submission, it becomes empty only on a confirmed server receipt.
- A draft that was following "today" moves to the current Qatar date when restored on a later day; an explicit owner backdate is kept.
- A stored record from a newer schema, a corrupt record, or one stored under a different user or shop is ignored, not guessed at. Records missing later-added optional fields load with defaults.
- A plain draft untouched for 30 days is removed on next load. A draft whose submission is still in doubt is never removed automatically.
- **Discard draft** removes it explicitly, after confirmation.
- Switching shops still asks to discard the current entry, as before; confirming removes that shop's stored draft.

If IndexedDB is unavailable the workspace still works and says the draft is not saved on this device.

## 4. What works offline, and what does not

| Works offline | Does not work offline |
| --- | --- |
| Typing, editing and removing draft rows | Saving a batch (it is queued, not saved) |
| Importing a workbook or pasting rows into the draft | Customer search and existing-customer selection |
| Downloading the import template | Checking invoice numbers against the shop's registry |
| Local Review batch with totals | Payments, customer payments, credit, expenses, corrections |
| Keeping and reopening the draft | Any export |
| Queuing the batch to send on reconnect | Viewing current invoices, balances or dues |

While offline, the recent-invoice list that was already on screen is labelled as loaded earlier and possibly out of date. After an offline page load no server data is shown at all. Duplicate numbers, closed dates and authorization are decided by the server when the batch is sent.

### States the user sees

One short status line in the entry panel:

| Line | Meaning |
| --- | --- |
| Saved locally | A draft exists on this device. Not sent. |
| Offline — draft saved locally | Same, and the device is offline. |
| Submission pending — will send when you reconnect | Saved was pressed offline. Queued, never sent, still editable. |
| Reconnecting — checking your session and shop access… | A reconnect attempt is scheduled or running. |
| Sending to ShopKhata… | A request is in flight. |
| Submission status uncertain — retry the same sale | A request was sent and no confirmed answer came back. The draft is locked. |
| Retry available — not saved to ShopKhata yet | A queued submission was refused before the server evaluated it; it can be retried. |
| Sign in again — draft saved locally | The session is gone. A link leads to the login form. |
| Conflict — not saved to ShopKhata | The server refused the batch; the reason is shown and the draft is kept. |
| Saved to ShopKhata | The server confirmed the commit. |

An app-wide banner appears whenever the device is offline.

## 5. Submission queue

The queue is deliberately small: the only queued mutation type is `invoice_batch`, and each user has at most one per shop, held inside that shop's draft record. Payments, customer payments, credit application and expenses are not queued; they need current server balances and stay online-only, each with its existing in-screen exact-retry behaviour.

A queued submission records: type, shop ID, idempotency key, the frozen payload (the exact `saveInvoiceBatch` input), when it was queued, attempt count, last error, and status — `queued` (never sent) or `uncertain` (sent at least once without a confirmed answer). It contains no SQL and nothing the server action would not accept from the form.

The payload and the idempotency key never change for the life of a submission. `uncertain` is written to the device before the request leaves, so closing the tab mid-request cannot turn an in-doubt submission back into an editable draft.

## 6. Retry and idempotency

`submit_batch` keys every batch by `(shop_id, idempotency_key)` with a fingerprint of the command. A repeat with the same key and payload returns the original result and writes nothing; the same key with a different payload fails with `IDEMPOTENCY_CONFLICT`.

The lost-response case therefore resolves safely: the server commits, the response is lost, the device shows *uncertain* and keeps the draft locked, and the retry — manual, on reconnect, or after a reload — sends the identical payload with the identical key and receives the original receipt. Only then is the draft cleared.

The server action returns a `code` saying what the server established, and the device acts on that rather than on message text:

| Outcome | Codes | Effect on the local submission |
| --- | --- | --- |
| Saved | receipt validated | Draft cleared. |
| Uncertain | no answer, or an unverifiable answer | Stays `uncertain`; payload and key kept. |
| Blocked | `UNAUTHENTICATED`, `UNAUTHORIZED_SHOP`, `INSUFFICIENT_ROLE`, `UNAVAILABLE` | Unchanged. The server refused before evaluating the key, so earlier uncertainty is not cleared. |
| Rejected | `VALIDATION`, `STALE_DATE`, `CLOSED_DATE`, `IDEMPOTENCY_CONFLICT` | Released for editing with a new key. The replay check runs before these, so they prove this key was not committed with this payload. |

### Reconnect

A reconnect does not replay blindly. On the browser's `online` event, or when a page loads with a stored submission, one attempt is scheduled after one second. Repeated `online` events collapse into that single attempt, and a request already in flight blocks another. The attempt calls the same server action, which in order: authenticates the session, checks the user's current access to the shop and role, looks up whether the key is already committed, re-validates the rows against the current registry, and only then calls the RPC, which repeats those checks authoritatively.

If the attempt fails at the network level it is retried after 5 and then 15 seconds. After three automatic attempts the status shows the retry as available and the user decides. A refusal or a rejection stops automatic retrying immediately.

A lost response while the device stays online is not retried automatically; the user presses **Retry same batch**, as before this slice.

## 7. Conflicts

No conflict is resolved by overwriting. The draft is always kept, and the server's state always wins.

**A — the invoice number was used while offline.** The batch is rejected as a whole; no row is committed. The affected row shows the error and the existing-invoice notice with its authoritative due and a link to the canonical invoice (Record payment or View invoice). The user renumbers or removes the row and saves again.

**B — customer data changed.** ShopKhata has no customer merge, deactivate or delete operation, so a referenced customer cannot disappear in normal use. If a reference is nevertheless invalid — an unknown ID or a customer of another shop — the server rejects the row with `CUSTOMER_NOT_FOUND`. Nothing is reassigned; the user selects a customer again.

**C — the business date was closed.** The server rejects the batch with `CLOSED_DATE`. The device explains that the date is closed and keeps the draft, including its date and backdate reason. Once the date is reopened the same draft saves normally.

**D — authorization changed.** If the user lost access to the shop, was deactivated, or is no longer an owner for a backdated batch, the server refuses. Having prepared the batch earlier grants nothing. The draft is kept; if access is restored, the same submission can be retried.

**Other conflicts handled:** a draft whose "today" has passed while a non-owner's batch was queued is rejected with `STALE_DATE` and returns for review on the current date; a key already used for a different payload is rejected and the draft gets a new key.

A conflict message is stored with the draft, so it is still shown after a reload.

### Session expiry

If the session is gone when a submission is sent, nothing is committed. The draft and its submission are kept, the status asks the user to sign in again, and automatic retrying stops. After signing in through the normal login form — which re-establishes the session and re-checks shop access on the server — the stored submission resumes with its original key. No credential is stored on the device at any point.

## 8. Installable shell and service worker

`/manifest.webmanifest` declares the app name, `id`, `scope`, `start_url`, standalone display, theme colours and 192/512 px icons (including a maskable one), so supporting browsers can install it.

`public/sw.js` is small and conservative:

- It caches only build assets under `/_next/static/`, the two icons, and the static `/offline` page.
- It never caches a page, an RSC payload, a Server Action response, an export, or any Supabase request. Non-GET requests are not touched at all.
- It is network-first everywhere, so nothing stale is served while online.
- When loading the workspace (`/`) fails at the network level, it answers with the cached `/offline` page. Other pages need live server data and are left to the browser.

`/offline` is a static page with no server data. It reopens the local draft for editing and queuing, hides every server-backed section, and never sends anything. It checks the server every five seconds and on the `online` event, and returns to the real workspace as soon as the server answers. It is reachable without a session so the service worker can cache it; the proxy exempts only this path.

`/sw.js` is served with `no-store` and a same-origin Content-Security-Policy.

A development server cannot start a page without its hot-reload connection, so real offline page loads are verified against a production build (`pwa` Playwright project).

## 9. Local data privacy

- Drafts are namespaced by authenticated user and shop. The workspace only ever reads the key of the signed-in user, and a stored record whose owner does not match is refused.
- A different user signing in on the same browser sees a blank workspace, never the previous user's rows.
- **Sign out** asks for confirmation and then deletes that user's drafts and the session marker from the device before ending the session.
- When a session simply expires, the draft stays on the device under its owner's key so it can be recovered after signing in again. It is not shown to anyone else through the app.
- The offline page opens a draft only for the user recorded in the local session marker, and only while the server cannot be reached. The marker holds a user ID, display name, role and shop names — no token. It is cleared on sign-out and whenever the login page is shown.
- No auth token is written to the app's IndexedDB. Supabase's own session cookies are unchanged.

Limit of this boundary: IndexedDB is not encrypted. Someone with access to the same browser profile and its developer tools can read a draft that has not been signed out of. Use explicit sign-out on shared devices.

## 10. Operational limits

| Limit | Value | Why |
| --- | --- | --- |
| Import file size | 1 MB | A 100-row workbook is a few kilobytes. |
| Rows per import and per batch | 100 | Matches the existing server action limit. |
| Drafts | 1 per user per shop per device | A batch belongs to one shop and one business date. |
| Queued submissions | 1 per user per shop per device | Held inside the draft. |
| Automatic reconnect attempts | 3, after 1 s, 5 s and 15 s | Then manual retry. |
| Plain draft retention | 30 days | Submissions in doubt are kept indefinitely. |
| Export rows | 20,000 per file | Read into memory; ask for a shorter range beyond that. |

## 11. Known limitations

- The offline page appears only when the request fails outright. On a connection that is up but unresponsive, a page load waits like any slow page; an open workspace keeps working, and a failed save becomes *uncertain* with a manual retry.
- Existing-customer selection and duplicate-number hints need the server and are unavailable offline.
- If a user loses access to their only shop, the workspace cannot open and the stored draft is unreachable until access is restored.
- An invoice and the payment recorded with it share one recorded timestamp, so their relative order in the ledger (screen and export alike) is not fixed and an intermediate running balance may differ; the final balance is always the authoritative one. This predates the slice.
- Only invoice batches can be queued offline.

## Import preview diagnostics

Every problem in the preview names the spreadsheet row, the column, the value the cell actually held and what is accepted there, for example: `Row 3: Delivered must be Yes or No.` — Column: Delivered · Received: `"maybe"` · Expected: Yes or No (any letter case), TRUE or FALSE, or blank for No. Text is shown in quotes so stray spaces and look-alike characters are visible. The offending cell is highlighted in the preview table and shows the received value rather than a default.

Delivered is normalized to a boolean before validation: surrounding whitespace is trimmed, `Yes`/`No` match in any letter case, and a real Excel `TRUE`/`FALSE` cell is accepted as it is. Anything that is not clearly one of the listed values is rejected, not guessed.

The import stays all-or-nothing: while any row has a problem, no row can be added to the draft.
