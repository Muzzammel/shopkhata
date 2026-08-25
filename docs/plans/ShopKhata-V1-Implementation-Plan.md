# ShopKhata V1 Implementation Plan

> **For agentic workers:** Execute one task at a time with a fresh context and a human review gate after every task. Codex is the primary implementation agent; Gemini Antigravity performs independent UI/runtime review. Only one agent may edit the repository at a time.

**Goal:** Build a standalone, installable, offline-tolerant two-shop web application for atomic bulk invoice entry, partial payments, customer dues and credits, expenses, attachments, backdated entry, daily closing, Excel import/export, and audit-safe corrections.

**Architecture:** A Next.js/TypeScript PWA uses Supabase PostgreSQL as the authoritative database and IndexedDB/Dexie as a local draft and synchronization outbox. Financial mutations execute through server-owned PostgreSQL functions inside database transactions; the browser never writes authoritative balances directly.

**Tech Stack:** Next.js, React, TypeScript, Supabase/PostgreSQL, Dexie/IndexedDB, Zod, React Hook Form, TanStack Table, decimal.js, `read-excel-file`, `write-excel-file`, Vitest, Testing Library, Playwright, pnpm.

**Spec:** `ShopKhata-Product-Design-Specification.md`

## Global Constraints

- Standalone product; no Mahira ERP code, data, authentication, or integration.
- Version 1 supports Shop 1 and Shop 2 but models shops as records, not hard-coded columns.
- Invoice identity is the unique pair `(shop_id, invoice_id)`; invoice IDs are text.
- QAR amounts support exactly two decimal places and use integer dirhams in application/domain interfaces.
- A submitted batch is atomic: every row succeeds or no row is committed.
- Financial history is append-only; corrections use reversals and adjustments.
- A delivered or Readymade invoice with due requires a selected customer.
- Overpayment requires approval, a reason, and a selected customer; excess becomes customer credit.
- Offline work is pending until server validation; financial conflicts never use last-write-wins.
- Business date and immutable recorded timestamp are separate.
- Only Owner/Admin may create backdated batches.
- Individual logins and database-enforced shop permissions are mandatory.
- Free infrastructure is an initial constraint, not a backup guarantee.
- AI/OCR, inventory, purchasing, suppliers, payroll, general ledger, WhatsApp automation, native mobile apps, and Mahira integration are excluded.

## Repository structure

```text
shopkhata/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (app)/layout.tsx
│   ├── (app)/daily-entry/page.tsx
│   ├── (app)/invoices/[invoiceId]/page.tsx
│   ├── (app)/customers/page.tsx
│   ├── (app)/customers/[customerId]/page.tsx
│   ├── (app)/expenses/page.tsx
│   ├── (app)/closing/page.tsx
│   ├── (app)/conflicts/page.tsx
│   ├── (app)/approvals/page.tsx
│   ├── (app)/reports/page.tsx
│   ├── (app)/admin/users/page.tsx
│   ├── api/batches/route.ts
│   ├── api/attachments/route.ts
│   ├── api/exports/route.ts
│   ├── api/imports/validate/route.ts
│   ├── manifest.ts
│   └── sw.ts
├── components/
│   ├── bulk-entry/
│   ├── customers/
│   ├── shared/
│   └── sync/
├── features/
│   ├── batches/
│   ├── invoices/
│   ├── payments/
│   ├── customers/
│   ├── expenses/
│   ├── closing/
│   ├── corrections/
│   ├── reports/
│   └── sync/
├── lib/
│   ├── domain/
│   ├── offline/
│   ├── supabase/
│   ├── auth/
│   └── excel/
├── supabase/
│   ├── migrations/
│   ├── seed.sql
│   └── tests/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docs/product/
├── public/
├── package.json
├── pnpm-lock.yaml
├── vitest.config.ts
└── playwright.config.ts
```

---

## Phase 1 — Foundation and executable domain rules

### Task 1: Scaffold the repository and verification harness

**Files:**
- Create: all root configuration files, `app/layout.tsx`, `app/page.tsx`, `app/manifest.ts`
- Create: `tests/unit/smoke.test.ts`, `tests/e2e/smoke.spec.ts`
- Create: `.env.example`, `.github/workflows/ci.yml`, `docs/product/ShopKhata-Product-Design-Specification.md`

**Interfaces:**
- Produces: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`

- [ ] **Step 1: Create the Next.js TypeScript application**

  Run:

  ```bash
  pnpm create next-app@latest shopkhata --ts --eslint --app --src-dir=false --import-alias='@/*'
  cd shopkhata
  pnpm add zod decimal.js @supabase/ssr @supabase/supabase-js dexie dexie-react-hooks react-hook-form @hookform/resolvers @tanstack/react-table read-excel-file write-excel-file
  pnpm add -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @playwright/test
  ```

- [ ] **Step 2: Add failing unit and browser smoke tests**

  ```ts
  // tests/unit/smoke.test.ts
  import { describe, expect, it } from "vitest";
  import { APP_NAME } from "@/lib/domain/constants";

  describe("ShopKhata foundation", () => {
    it("exposes the approved product name", () => {
      expect(APP_NAME).toBe("ShopKhata");
    });
  });
  ```

  ```ts
  // tests/e2e/smoke.spec.ts
  import { expect, test } from "@playwright/test";

  test("renders the application shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "ShopKhata" })).toBeVisible();
  });
  ```

- [ ] **Step 3: Verify the tests fail for missing implementation**

  Run: `pnpm test --run && pnpm test:e2e`  
  Expected: unit test fails because `lib/domain/constants.ts` does not exist; browser test fails until the shell is implemented.

- [ ] **Step 4: Add the minimal shell, scripts, Vitest, Playwright, and CI configuration**

  ```ts
  // lib/domain/constants.ts
  export const APP_NAME = "ShopKhata" as const;
  export const CURRENCY = "QAR" as const;
  ```

  CI must run install with frozen lockfile, lint, typecheck, unit tests, production build, and Playwright smoke tests.

- [ ] **Step 5: Copy the approved specification into `docs/product/` unchanged and verify**

  Run: `pnpm lint && pnpm typecheck && pnpm test --run && pnpm build && pnpm test:e2e`  
  Expected: all commands pass.

- [ ] **Step 6: Commit**

  ```bash
  git add .
  git commit -m "chore: establish ShopKhata application foundation"
  ```

### Task 2: Implement money, identifiers, invoice states, and batch validation

**Files:**
- Create: `lib/domain/money.ts`, `lib/domain/ids.ts`, `lib/domain/invoices.ts`, `lib/domain/batches.ts`, `lib/domain/errors.ts`
- Create: `tests/unit/domain/money.test.ts`, `tests/unit/domain/invoices.test.ts`, `tests/unit/domain/batches.test.ts`

**Interfaces:**
- Produces: `type MoneyDirham = number`, `parseQar(value: string): MoneyDirham`, `formatQar(value: MoneyDirham): string`
- Produces: `invoiceKey(shopId: string, invoiceId: string): string`
- Produces: `validateBatch(input: BatchDraft, context: ValidationContext): BatchValidationResult`

- [ ] **Step 1: Write failing exact-money tests**

  ```ts
  expect(parseQar("125.50")).toBe(12550);
  expect(parseQar("0.01")).toBe(1);
  expect(() => parseQar("12.345")).toThrow("AMOUNT_PRECISION");
  expect(formatQar(12550)).toBe("125.50");
  ```

- [ ] **Step 2: Write failing lifecycle and validation tests**

  Cover:
  - same invoice ID in different shops is valid;
  - duplicate new invoice ID inside one shop is invalid;
  - Readymade is delivered automatically;
  - delivered due without customer returns `CUSTOMER_REQUIRED`;
  - fully paid anonymous invoice is valid;
  - overpayment without approval returns `OVERPAYMENT_APPROVAL_REQUIRED`;
  - overpayment without customer returns `OVERPAYMENT_CUSTOMER_REQUIRED`;
  - one invalid row makes `canSubmit` false.

- [ ] **Step 3: Run tests and confirm domain modules are missing**

  Run: `pnpm vitest run tests/unit/domain`  
  Expected: FAIL on unresolved imports.

- [ ] **Step 4: Implement the minimal pure domain modules**

  `BatchValidationResult` must contain:

  ```ts
  type BatchValidationResult = {
    canSubmit: boolean;
    rowErrors: Array<{ rowId: string; field: string; code: string; message: string }>;
    warnings: Array<{ rowId: string; code: string; message: string }>;
    totals: { invoiced: MoneyDirham; received: MoneyDirham; due: MoneyDirham };
  };
  ```

- [ ] **Step 5: Verify domain tests and full regression suite**

  Run: `pnpm vitest run tests/unit/domain && pnpm test --run && pnpm typecheck`  
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/domain tests/unit/domain
  git commit -m "feat: define ShopKhata financial domain rules"
  ```

---

## Phase 2 — Authoritative database and access control

### Task 3: Create the PostgreSQL schema, constraints, and seed data

**Files:**
- Create: `supabase/migrations/0001_core_schema.sql`
- Create: `supabase/migrations/0002_financial_schema.sql`
- Create: `supabase/seed.sql`
- Create: `supabase/tests/schema.test.sql`
- Create: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces database tables: `shops`, `profiles`, `user_shop_assignments`, `customers`, `batches`, `invoices`, `payments`, `customer_credits`, `expenses`, `attachments`, `corrections`, `daily_closes`, `audit_events`
- Money columns use `bigint` dirhams; IDs use UUID except human-facing customer ID and user-entered invoice ID.

- [ ] **Step 1: Write pgTAP tests before migrations**

  Tests must assert:
  - all required tables exist;
  - `unique(shop_id, invoice_id)` exists;
  - amounts are non-negative except signed correction deltas;
  - customer human IDs are unique;
  - invoice and audit recorded timestamps are server generated;
  - financial event rows reject update/delete for application roles.

- [ ] **Step 2: Run schema tests and verify failure**

  Run: `supabase db reset && supabase test db`  
  Expected: FAIL because migrations do not exist.

- [ ] **Step 3: Implement normalized schema and append-only triggers**

  The invoice constraint must be explicit:

  ```sql
  create unique index invoices_shop_invoice_id_uq
    on public.invoices (shop_id, invoice_id);
  ```

  Customer public IDs use a sequence-backed formatter such as `CUS-00001`; invoice IDs remain user-controlled text.

- [ ] **Step 4: Seed two shops and test users without production credentials**

  Seed `Shop 1` and `Shop 2`; create deterministic local-test profiles only when the Supabase local environment is active.

- [ ] **Step 5: Generate TypeScript database types and verify**

  Run:

  ```bash
  supabase db reset
  supabase test db
  supabase gen types typescript --local > lib/supabase/database.types.ts
  pnpm typecheck
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add supabase lib/supabase/database.types.ts
  git commit -m "feat: add authoritative ShopKhata database schema"
  ```

### Task 4: Implement authentication, roles, and row-level security

**Files:**
- Create: `lib/supabase/browser.ts`, `lib/supabase/server.ts`, `lib/auth/permissions.ts`, `middleware.ts`
- Create: `app/(auth)/login/page.tsx`, `app/(app)/layout.tsx`
- Create: `supabase/migrations/0003_rls.sql`, `supabase/tests/rls.test.sql`
- Create: `tests/unit/auth/permissions.test.ts`, `tests/e2e/auth.spec.ts`

**Interfaces:**
- Produces: `getCurrentActor(): Promise<Actor>`
- Produces: `can(actor: Actor, action: Permission, shopId?: string): boolean`
- RLS exposes only assigned-shop records except Owner/Admin.

- [ ] **Step 1: Write failing permission matrix and RLS tests**

  Assert staff cannot read Shop 2 when assigned only to Shop 1, Manager sees assigned shops, Owner sees both, and deactivated users cannot mutate.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/unit/auth && supabase test db`  
  Expected: FAIL because policies and permission functions do not exist.

- [ ] **Step 3: Implement SSR authentication and permission helpers**

  Do not accept role or shop IDs from untrusted client claims. Resolve them from server-side profile and assignment tables.

- [ ] **Step 4: Implement RLS and security-definer helper functions with locked search paths**

  Every exposed table must enable RLS. Financial command functions are the only write route for authoritative financial tables.

- [ ] **Step 5: Verify unit, database, and browser authorization tests**

  Run: `pnpm test --run && supabase test db && pnpm test:e2e --grep auth`  
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add app lib middleware.ts supabase tests
  git commit -m "feat: enforce individual and shop-scoped access"
  ```

---

## Phase 3 — Atomic financial commands

### Task 5: Implement atomic batch submission and idempotency

**Files:**
- Create: `supabase/migrations/0004_submit_batch.sql`
- Create: `supabase/tests/submit_batch.test.sql`
- Create: `features/batches/contracts.ts`, `features/batches/submit-batch.ts`
- Create: `app/api/batches/route.ts`
- Create: `tests/integration/batches/submit-batch.test.ts`

**Interfaces:**
- Consumes: `BatchDraft`, authenticated `Actor`
- Produces: `submit_batch(command jsonb) returns jsonb`
- Produces: `submitBatch(command: SubmitBatchCommand): Promise<SubmitBatchResult>`

- [ ] **Step 1: Write failing database tests for atomicity**

  Assert:
  - four valid rows commit together;
  - one duplicate row leaves invoice/payment counts unchanged;
  - repeated idempotency key returns the same batch ID;
  - unauthorized shop command fails;
  - closed date fails;
  - server recalculates totals and rejects mismatched client totals.

- [ ] **Step 2: Run and confirm failure**

  Run: `supabase test db --file supabase/tests/submit_batch.test.sql`  
  Expected: FAIL because `submit_batch` is missing.

- [ ] **Step 3: Implement the database transaction function**

  The function must lock referenced invoices, validate versions and current due, insert the batch/events, and create one audit event. It must not accept client-computed remaining balances as truth.

- [ ] **Step 4: Add typed server adapter and route**

  Return structured errors:

  ```ts
  type SubmitBatchResult =
    | { ok: true; batchId: string; recordedAt: string; rowResults: RowResult[] }
    | { ok: false; code: "VALIDATION" | "CONFLICT" | "FORBIDDEN" | "CLOSED_DATE"; rowErrors: RowError[] };
  ```

- [ ] **Step 5: Run database and integration tests**

  Run: `supabase db reset && supabase test db && pnpm vitest run tests/integration/batches`  
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add supabase features app/api tests/integration
  git commit -m "feat: submit financial batches atomically"
  ```

### Task 6: Implement payments, overpayment approval, and customer credit

**Files:**
- Create: `supabase/migrations/0005_payments_and_credits.sql`
- Create: `supabase/tests/payments.test.sql`
- Create: `features/payments/contracts.ts`, `features/payments/payment-policy.ts`
- Create: `tests/unit/payments/payment-policy.test.ts`, `tests/integration/payments/payments.test.ts`

**Interfaces:**
- Produces command row kinds: `ADVANCE_INVOICE`, `PAYMENT`, `DELIVERY`, `READYMADE_SALE`
- Produces: `approve_overpayment(command jsonb) returns jsonb`

- [ ] **Step 1: Write failing payment tests**

  Cover QAR 1,000 due receiving QAR 400 then QAR 600; concurrent QAR 600 payments; overpayment blocked without approval; overpayment requires customer and reason; QAR 700 against QAR 600 due produces exactly QAR 100 credit.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/unit/payments && supabase test db`  
  Expected: FAIL on missing policy/command.

- [ ] **Step 3: Implement payment policy and row locking**

  Use invoice row version plus `select ... for update`. Ensure due can never fall below zero and credit creation is in the same transaction.

- [ ] **Step 4: Implement separate staff actor and approving actor audit fields**

  Approval records store `requested_by`, `approved_by`, `reason`, `approved_at`, due before, payment amount, applied amount, and credit amount.

- [ ] **Step 5: Run all payment and concurrency tests**

  Run: `supabase test db && pnpm vitest run tests/unit/payments tests/integration/payments`  
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add supabase features/payments tests
  git commit -m "feat: support partial payments and approved customer credit"
  ```

---

## Phase 4 — Bulk-entry experience and Excel interchange

### Task 7: Build the keyboard-first bulk-entry grid

**Files:**
- Create: `app/(app)/daily-entry/page.tsx`
- Create: `components/bulk-entry/BulkEntryGrid.tsx`, `BulkEntryToolbar.tsx`, `BatchTotals.tsx`, `RowError.tsx`, `MobileInvoiceCard.tsx`
- Create: `features/batches/draft-reducer.ts`, `features/batches/use-batch-draft.ts`
- Create: `tests/unit/bulk-entry/draft-reducer.test.ts`, `tests/e2e/bulk-entry.spec.ts`

**Interfaces:**
- Consumes: `validateBatch`, `submitBatch`
- Produces: `useBatchDraft({ shopId, businessDate })`
- Supports typed rows and tabular paste.

- [ ] **Step 1: Write reducer and browser tests before UI**

  Assert add/remove/update row, paste four tab-separated rows, Tab/Enter navigation, calculated totals, exact cell errors, customer requirement, and disabled save while one blocking error exists.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/unit/bulk-entry && pnpm test:e2e --grep bulk-entry`  
  Expected: FAIL because components and reducer are missing.

- [ ] **Step 3: Implement reducer and desktop grid**

  Keep state normalized by stable local row IDs. Never use array index as the React key. Paste parsing must reject extra columns rather than shifting financial fields.

- [ ] **Step 4: Implement phone card adaptation and accessibility**

  Use the approved structure: desktop/tablet grid and mobile cards. Provide visible labels, keyboard focus, error summaries linked to cells, and non-color error indicators.

- [ ] **Step 5: Connect validation and atomic submission**

  On success, show server batch ID and clear only the committed draft. On failure, retain every row and apply returned errors.

- [ ] **Step 6: Verify**

  Run: `pnpm lint && pnpm typecheck && pnpm test --run && pnpm test:e2e --grep bulk-entry`  
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add app components features tests
  git commit -m "feat: add atomic Excel-like daily bulk entry"
  ```

### Task 8: Implement controlled Excel import and export

**Files:**
- Create: `lib/excel/template.ts`, `lib/excel/import.ts`, `lib/excel/export.ts`
- Create: `app/api/imports/validate/route.ts`, `app/api/exports/route.ts`
- Create: `components/bulk-entry/ExcelImportDialog.tsx`
- Create: `tests/unit/excel/import.test.ts`, `tests/integration/excel/export.test.ts`, `tests/fixtures/excel/`

**Interfaces:**
- Produces: `parseStandardImport(file): ParsedBatchDraft`
- Produces: `parseBackdatedImport(file): Map<ShopBusinessDateKey, ParsedBatchDraft>`
- Produces: `buildExport(query): Promise<Uint8Array>`

- [ ] **Step 1: Create fixture workbooks and failing parser tests**

  Cover invoice IDs with leading zeroes, decimals, invalid columns, duplicate rows, standard single-date import, and Owner/Admin multi-date grouping.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/unit/excel`  
  Expected: FAIL on missing parser.

- [ ] **Step 3: Implement fixed templates and schema-based parsing**

  Treat invoice ID columns as text. Standard import inherits selected shop/date. Backdated import requires explicit shop and business-date columns and Owner/Admin permission.

- [ ] **Step 4: Apply identical domain and server validation**

  Import code may only create `BatchDraft`; it must call the same `validateBatch` and `submitBatch` routes used by manual entry.

- [ ] **Step 5: Implement exports and reconciliation tests**

  Export separate fields for invoiced total, received, due, credit, expenses, business date, recorded time, and audit references. Test totals against database fixtures.

- [ ] **Step 6: Verify and commit**

  Run: `pnpm test --run && pnpm typecheck`

  ```bash
  git add lib/excel app/api components tests
  git commit -m "feat: add validated Excel import and auditable exports"
  ```

---

## Phase 5 — Offline drafts and conflict-safe synchronization

### Task 9: Implement IndexedDB drafts, outbox, and retry safety

**Files:**
- Create: `lib/offline/db.ts`, `lib/offline/schema.ts`, `features/sync/outbox.ts`, `features/sync/sync-engine.ts`, `features/sync/conflicts.ts`
- Create: `components/sync/SyncStatus.tsx`, `app/(app)/conflicts/page.tsx`
- Create: `tests/unit/offline/outbox.test.ts`, `tests/integration/offline/sync-engine.test.ts`, `tests/e2e/offline.spec.ts`

**Interfaces:**
- Produces: `queueBatch(draft): Promise<OutboxItem>`
- Produces: `syncPending(): Promise<SyncSummary>`
- Outbox states: `DRAFT`, `PENDING`, `SYNCING`, `COMMITTED`, `CONFLICT`, `FAILED_RETRYABLE`

- [ ] **Step 1: Write failing outbox state-machine tests**

  Assert stable idempotency key, safe network retry, no editing after `SYNCING`, committed removal only after server confirmation, and conflict retains the full original draft.

- [ ] **Step 2: Write failing browser offline tests**

  In Playwright, disable network, enter a batch, reload, confirm persistence, restore network, synchronize, and confirm one server batch.

- [ ] **Step 3: Verify failure**

  Run: `pnpm vitest run tests/unit/offline tests/integration/offline && pnpm test:e2e --grep offline`  
  Expected: FAIL because local database and sync engine are missing.

- [ ] **Step 4: Implement Dexie schema and outbox state machine**

  Store drafts, row data, referenced invoice versions, attachments queue, attempts, and last error. Request persistent browser storage and display whether it was granted.

- [ ] **Step 5: Implement server-authoritative sync and conflict UI**

  Never auto-rewrite the command after a conflict. Show server due/version beside pending values and require the user to revise or cancel the draft.

- [ ] **Step 6: Verify offline, retry, duplicate-ID, stale-payment, and closed-date scenarios**

  Run: `pnpm test --run && pnpm test:e2e --grep offline`  
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add lib/offline features/sync components/sync app tests
  git commit -m "feat: add conflict-safe offline batch synchronization"
  ```

---

## Phase 6 — Customers, expenses, attachments, and operational history

### Task 10: Build customer ledger and invoice history

**Files:**
- Create: `app/(app)/customers/page.tsx`, `app/(app)/customers/[customerId]/page.tsx`, `app/(app)/invoices/[invoiceId]/page.tsx`
- Create: `features/customers/queries.ts`, `features/customers/create-customer.ts`, `features/invoices/queries.ts`
- Create: `components/customers/CustomerLedger.tsx`
- Create: `tests/integration/customers/ledger.test.ts`, `tests/e2e/customers.spec.ts`

**Interfaces:**
- Produces: `createCustomer({ name?, mobile? }): Promise<{ customerId: string }>`
- Produces: `getCustomerLedger(customerId): Promise<LedgerEntry[]>`

- [ ] **Step 1: Write failing tests for automatic customer IDs and ledger reconciliation**

  Assert unnamed customers receive unique IDs, due invoices increase balance, payments reduce it, approved excess increases credit, and corrections remain visible.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/integration/customers`  
  Expected: FAIL on missing query/command modules.

- [ ] **Step 3: Implement server queries and customer creation**

  Search by customer ID, optional name, optional mobile, and linked invoice ID. Do not expose other-shop restricted invoice details.

- [ ] **Step 4: Build customer and invoice history screens**

  Show business date and recorded timestamp separately, plus invoices, payments, credits, delivery state, corrections, and remaining balance.

- [ ] **Step 5: Verify and commit**

  Run: `pnpm test --run && pnpm test:e2e --grep customers`

  ```bash
  git add app features components tests
  git commit -m "feat: add customer and invoice ledgers"
  ```

### Task 11: Add expenses and private attachments

**Files:**
- Create: `app/(app)/expenses/page.tsx`, `features/expenses/commands.ts`
- Create: `app/api/attachments/route.ts`, `features/attachments/storage.ts`, `components/shared/AttachmentUploader.tsx`
- Create: `supabase/migrations/0006_storage_policies.sql`
- Create: `tests/integration/expenses/expenses.test.ts`, `tests/integration/attachments/attachments.test.ts`, `tests/e2e/attachments.spec.ts`

**Interfaces:**
- Produces: `createExpense(command): Promise<ExpenseResult>`
- Produces: `queueAttachment({ scope, localFile }): Promise<QueuedAttachment>`

- [ ] **Step 1: Write failing expense and storage-policy tests**

  Assert QAR precision, assigned-shop access, optional attachment, private object access, batch/invoice linkage, retry visibility, and no public URLs.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/integration/expenses tests/integration/attachments`  
  Expected: FAIL.

- [ ] **Step 3: Implement expense command and append-only behavior**

  Expense corrections use the same reversal model as financial records; no direct update/delete.

- [ ] **Step 4: Implement image preview, compression, offline queue, upload, and authorization**

  Preserve legibility, record original filename/type/size/hash, and expose explicit `QUEUED`, `UPLOADED`, and `FAILED` states.

- [ ] **Step 5: Verify and commit**

  Run: `pnpm test --run && pnpm test:e2e --grep attachments`

  ```bash
  git add app features components supabase tests
  git commit -m "feat: add shop expenses and private evidence attachments"
  ```

---

## Phase 7 — Corrections, closing, and backdated operations

### Task 12: Implement correction, approval, daily close, and backdated commands

**Files:**
- Create: `supabase/migrations/0007_operational_controls.sql`
- Create: `supabase/tests/operational_controls.test.sql`
- Create: `features/corrections/commands.ts`, `features/closing/commands.ts`, `features/batches/backdated.ts`
- Create: `app/(app)/approvals/page.tsx`, `app/(app)/closing/page.tsx`
- Create: `tests/integration/controls/controls.test.ts`, `tests/e2e/controls.spec.ts`

**Interfaces:**
- Produces: `requestCorrection`, `approveCorrection`, `closeBusinessDate`, `reopenBusinessDate`, `submitBackdatedBatch`

- [ ] **Step 1: Write failing database and integration tests**

  Assert original financial rows remain immutable; correction creates reversal/adjustment; close blocks entries; reopen requires permission/reason; future business date is blocked; backdated entry requires Owner/Admin and reason; business date differs from recorded timestamp.

- [ ] **Step 2: Verify failure**

  Run: `supabase test db && pnpm vitest run tests/integration/controls`  
  Expected: FAIL on missing commands.

- [ ] **Step 3: Implement correction and approval commands**

  Store original record reference, requested/approved actors, reason, signed financial effect, and recorded timestamp in one transaction.

- [ ] **Step 4: Implement close/reopen and backdated commands**

  Backdated multi-date import creates separate transactions per `(shop_id, business_date)` and returns a result per group. It never merges dates into one batch.

- [ ] **Step 5: Build approval and closing screens**

  Clearly show business date, recorded timestamp, shop, requester, approver, reason, before/after effects, and current synchronization risk.

- [ ] **Step 6: Verify and commit**

  Run: `supabase test db && pnpm test --run && pnpm test:e2e --grep controls`

  ```bash
  git add supabase features app tests
  git commit -m "feat: add auditable corrections closing and backdating"
  ```

---

## Phase 8 — Reporting, backup, security verification, and production gate

### Task 13: Build reconciled owner reporting

**Files:**
- Create: `features/reports/queries.ts`, `features/reports/definitions.ts`
- Create: `app/(app)/reports/page.tsx`
- Create: `tests/integration/reports/reconciliation.test.ts`, `tests/e2e/reports.spec.ts`

**Interfaces:**
- Produces: `getShopSummary({ shopIds, from, to }): Promise<ShopSummary>`

- [ ] **Step 1: Write failing reconciliation tests**

  Assert invoice sales, money received, outstanding invoice due, customer due, customer credit, expenses, and net cash are distinct and reconcile to fixtures. Backdated records group by business date while late-entry report uses recorded timestamp.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run tests/integration/reports`  
  Expected: FAIL.

- [ ] **Step 3: Implement database-backed definitions and reports UI**

  `netCashDirham = receivedDirham - expensesDirham`. Never label it profit. Owner may combine shops; staff/manager queries remain scoped.

- [ ] **Step 4: Verify reports against direct database totals**

  Run: `pnpm vitest run tests/integration/reports && pnpm test:e2e --grep reports`  
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add features/reports app tests
  git commit -m "feat: add reconciled shop and owner reporting"
  ```

### Task 14: Add backup operations and production acceptance gates

**Files:**
- Create: `scripts/backup-database.mjs`, `scripts/verify-backup.mjs`, `docs/operations/backup-and-restore.md`, `docs/operations/production-checklist.md`
- Create: `tests/e2e/production-acceptance.spec.ts`, `tests/security/authorization.spec.ts`
- Modify: `.github/workflows/ci.yml`, `app/(app)/reports/page.tsx`

**Interfaces:**
- Produces: `pnpm backup:db`, `pnpm backup:verify`, dashboard `lastSuccessfulBackupAt`

- [ ] **Step 1: Write failing backup verification and full acceptance tests**

  Include every acceptance scenario from Specification §20, trusted-device offline-storage warning, image failure visibility, Excel round-trip, and cross-shop authorization attempts.

- [ ] **Step 2: Verify failure**

  Run: `pnpm test:e2e --grep production-acceptance && pnpm backup:verify`  
  Expected: FAIL because backup and final gates are missing.

- [ ] **Step 3: Implement database dump wrapper and restore verification**

  The dump target must be outside the hosting account. Never commit credentials or dumps. Verification restores into a disposable local database and compares table counts plus selected financial hashes.

- [ ] **Step 4: Add backup status and production checklist**

  The checklist requires tested restore, owner/admin creation, two-shop assignments, RLS pass, offline conflict pass, browser coverage, exported full backup, and documented rollback.

- [ ] **Step 5: Run the complete verification matrix**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test --run --coverage
  supabase db reset
  supabase test db
  pnpm build
  pnpm test:e2e
  pnpm backup:verify
  ```

  Expected: every command passes; no skipped financial, authorization, offline, or restore test.

- [ ] **Step 6: Perform independent Antigravity review without edits**

  Review desktop/tablet/phone entry, keyboard flow, offline/reconnect, exact warnings, closed-date behavior, and accessibility. Return findings to Codex; Codex makes any approved fixes and reruns the complete matrix.

- [ ] **Step 7: Commit the production candidate**

  ```bash
  git add .
  git commit -m "chore: complete ShopKhata production acceptance gate"
  git tag shopkhata-v1-rc1
  ```

## Phase gates

| Gate | Required evidence |
|---|---|
| Phase 1 | App builds; domain money and lifecycle tests pass |
| Phase 2 | Schema, constraints, individual authentication, and RLS tests pass |
| Phase 3 | Atomic batch, idempotency, partial-payment, overpayment, and concurrency tests pass |
| Phase 4 | Approved bulk-entry UI works; Excel imports share the same validation path |
| Phase 5 | Offline persistence, safe retry, and four conflict scenarios pass |
| Phase 6 | Customer ledger reconciles; expenses and private attachments work |
| Phase 7 | Immutable corrections, close/reopen, and backdated operations pass |
| Phase 8 | Reports reconcile; backup restore and complete production acceptance pass |

## Execution order and review policy

1. Execute Tasks 1–14 strictly in order.
2. Stop after each task for diff, test-output, and scope review.
3. Do not begin a later phase while its preceding gate is failing.
4. Codex is the only editor during an implementation task.
5. Antigravity reviews only after Codex commits a reviewable checkpoint; it does not edit concurrently.
6. Any new requirement returns to the product specification before implementation.
7. Deploy only after Task 14 passes and the user approves the release candidate.
