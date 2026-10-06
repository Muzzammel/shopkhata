# One-shop pilot runbook

Do not onboard both shops at once. Production rollout is a controlled operator decision, and no step here authorizes an automatic deployment.

## Phase 1: owner-only verification

1. Complete [production-checklist.md](production-checklist.md) and the [release checklist](release-checklist.md).
2. Provision the owner in Supabase Auth, then register the profile using the documented owner process. Disable public sign-up. Keep a second trusted owner account for recovery; do not share accounts.
3. Owner verifies both shop names, correct Qatar business date, all navigation and role visibility. Confirm production URL, TLS, auth site URL and redirect allowlist.
4. Use a designated pilot shop. If operational acceptance requires test transactions, mark every record clearly (for example, `PILOT-SMOKE-YYYYMMDD`), use a safe current business date, and get the owner to approve them. Never delete financial history. Correct mistakes with the governed correction flow or isolate test activity in a dedicated pilot shop.
5. Verify invoice, detail, payment, due, customer ledger, expense, dashboard and reports. Test close/reopen only on a safe date and only with the authorized owner/manager.
6. Run a complete database-plus-receipt backup and verify a restore locally. Copy the backup off-host.
7. Install and use the production PWA on the shop's actual supported desktop and phone. Verify offline draft persistence, reconnection, and update after a release.

## Phase 2: one-shop staff pilot

1. Select one shop and provision only its staff. Create each Auth user, register that account in ShopKhata Accounts, assign the role and selected shop, then verify effective access while signed in as that user.
2. Train staff with [staff guide](staff-guide.md). Each person uses an individual account and their own device/profile.
3. Operate real transactions for several business days. Owner checks daily close discipline, reports, failed/uncertain operations, receipt attachments and daily verified backups.
4. Record concrete friction with date, browser/device, route, safe error code/reference and whether data was confirmed. Do not include passwords, tokens, private receipt URLs or full customer/payment payloads.
5. Pause expansion for any unexplained balance mismatch, uncertain transaction, cross-shop access, missing receipt, repeated production error, failed backup or untrained operator.

## Phase 3: second shop

Expand only after the owner has reviewed several stable business days, reconciled closing/report totals, verified backups and restore evidence, resolved pilot incidents, and approved the next release. Provision second-shop staff individually; repeat role, assignment, cross-shop denial, device, daily close and backup acceptance. Do not copy a first-shop staff assignment to the second shop by assumption.

## Daily operating rhythm

- Staff records source documents promptly and checks the returned result.
- A slow screen or network error is not proof a write failed. Do not submit a new payment or replacement invoice. Follow the form's retry guidance and ask the owner to check the canonical record.
- Authorized manager/owner reviews the date and totals before daily close.
- Owner/operator takes and verifies `pnpm backup:db` after close, moves the encrypted backup off-host, and records the result outside the repository.
- Owner reviews hosting errors, Supabase database/storage logs, failed RPC codes and staff-reported uncertainty.

## Device acceptance

For each actual device: record model/OS/browser and date; HTTPS login, install prompt, standalone launch, core navigation, invoice draft, reconnect/retry, receipt upload, logout, and update after a new deployment. Never claim a physical-device result from Playwright emulation.
