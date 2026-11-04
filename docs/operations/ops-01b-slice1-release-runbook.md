# OPS-01B slice 1 — maintenance release runbook

The production release of OPS-01B slice 1 (invoice void, historical-sales remediation, sales-RPC release compatibility) behind a two-layer maintenance boundary. Read it end to end before starting. Every step names the command, what it must print, and what to do if it does not.

This runbook is the reviewed procedure. Do not improvise around it during the window; if a check fails, take the failure branch written next to it.

## 1. What the release contains

| # | Migration | Effect |
|---|---|---|
| 36 | `20261103140000_ops_01b_maintenance_guard.sql` | Maintenance state, write guard on every business RPC, Storage receipt guard, owner control RPCs. No behaviour change while maintenance is off. |
| 37 | `20261103150000_ops_01b_invoice_void.sql` | `void_invoice` (guarded from its first statement). |
| 38 | `20261103190000_ops_01b_void_remediation.sql` | Business-date sales movements; `report_sales_totals` new shape. |
| 39 | `20261103203806_ops_01b_sales_totals_release_compat.sql` | `report_sales_totals.effective_total_dirham` restored as a deprecated alias of net sales. |

Production before the release: 35 migrations (last `20261031165915`), app `e4f4cfe` (`dpl_8BXn…`). Candidate app: the commit that contains this runbook.

The old app on a database at 37 or 38 shows wrong numbers or error pages (the Dashboard and Sales report fail at 37). That is why traffic stays closed from before 37 until the candidate is serving and smoked.

## 2. The boundary

Two independent controls. Both must be on for every state between "maintenance locked" and "reopen".

**Vercel Firewall (app traffic).** One custom rule on project `shopkhata`:

- `host eq shopkhata.vercel.app` AND `path neq /api/health` AND `ip_address neq <OPERATOR_IP>` → `deny` (403).
- Live about 1 s after `publish`; survives promote and rollback (rehearsed 2026-11-04).
- Blocks pages, RSC requests, Server Action POSTs, API routes and static assets for everyone except the operator's IP. Deployment hosts (`shopkhata-<hash>-…vercel.app`) are behind Vercel Authentication and are not used.
- `/api/health` stays reachable. It is a GET-only route that reads two environment variables and returns `{status, release}`; it makes no database call and returns no business data. Rehearsed variants: `/api/health`, `/api/health/`, `/api/health?x=1` and `/api/%68ealth` reach the health route; `/API/HEALTH` passes the firewall (its path match ignores case) but Next routes and the proxy's health exemption are case-sensitive, so the app treats it as an unknown path (404, or a sign-in redirect to `/login`, which the firewall denies) and no business route is reachable; `/api/health/../dashboard`, `/api/health%2F..%2Fdashboard` and `/api/healthz` are denied.

**Database maintenance (direct Supabase traffic).** Migration 36 adds:

- `private.system_maintenance`: one row (`enabled`, `enabled_at/by`, `reason`, `release_ref`, and the operator bypass `bypass_user_id`, `bypass_expires_at`, `bypass_enabled_by`, `bypass_reason`). No API role can read or write it.
- `private.assert_not_in_maintenance()`: the first statement of all 24 business write RPCs. While maintenance is on it raises `MAINTENANCE_ACTIVE`, before validation, locks, sequences or writes. It takes `FOR SHARE` on the state row. The control RPCs take `FOR UPDATE`, so an enable waits for in-flight writes to commit, and every write that starts after the enable refuses.
- The Storage INSERT policy on `expense-receipts` carries the same check, so a direct browser upload is refused and no object is created.
- `public.set_maintenance({enabled, reason, release_ref?})` and `public.set_maintenance_bypass({user_id|null, minutes 1–120, reason})`: active owner only, reason required, idempotent (a repeat returns `changed: false` and writes no audit row), audited in `audit_events` as `maintenance.enabled`, `maintenance.disabled`, `maintenance.operator_bypass_enabled` and `maintenance.operator_bypass_disabled`. Disabling maintenance also removes any bypass.
- **Operator bypass:** one owner account, until an expiry of at most 120 minutes. While it is valid, that owner's own writes pass the maintenance guard and nothing else changes: role, shop status, closed dates and every other RPC check still apply. Managers and staff can never hold it.

Reads (tables, views, report RPCs) are not blocked by the database. RLS still scopes them to each user's own shops, so a user who calls the Data API directly sees only data they can already see. The firewall keeps the app's report screens closed during the window.

**Who is exposed to what during the window:**

| Path | Ordinary users | Operator (bypass on, operator IP) |
|---|---|---|
| App pages, Server Actions, API routes | 403 (firewall) | allowed |
| Direct RPC writes (any of 24) | `MAINTENANCE_ACTIVE` | allowed within the owner role |
| Direct Storage receipt upload | refused by RLS, no object | allowed |
| REST table INSERT/UPDATE/DELETE | refused (no grant, ever) | refused |
| Direct reads (REST/report RPCs) | own shops only (RLS) | owner |
| Existing signed receipt URLs | readable until expiry (300 s); read-only | — |
| GraphQL | not installed (`pg_graphql` absent) | — |
| Realtime | no tables published | — |
| Edge Functions | none deployed | — |

## 3. Variables for the window

Keep these in a password manager or the shell session, never in a file in the repository.

```
DB_URL=<production database URL>                 # project ref karvhrylmogxxfegubnc
OWNER_ID=<owner auth user id>                    # select id from public.profiles where role = 'owner' and is_active
OPERATOR_IP=<the operator's public IP>           # curl -s https://api.ipify.org
CANDIDATE_SHA=<full candidate commit>
RELEASE_REF=ops-01b-slice1-$CANDIDATE_SHA
```

`OPERATOR_IP` must be a network no staff member shares (use a phone hotspot, not the shop Wi-Fi). Check it from the network you will smoke from, and again before Step 9: mobile IPs change. If it changes during the window, edit the firewall rule (§6) before continuing.

Vercel commands run from a folder linked to project `shopkhata` (copy `.vercel/project.json` only) with `--scope muzzammels-projects`. In Git Bash set `MSYS_NO_PATHCONV=1`.

## 4. Applying migrations one at a time

`supabase db push` applies every pending migration. To stop at a given migration, push from a staging folder that holds only the migrations up to that point:

```
stage() {   # stage <last migration version>
  S="$(mktemp -d)"; mkdir -p "$S/supabase/migrations"; cp supabase/config.toml "$S/supabase/"
  for f in supabase/migrations/*.sql; do v="$(basename "$f" | cut -d_ -f1)"; [ "$v" \> "$1" ] || cp "$f" "$S/supabase/migrations/"; done
  echo "$S"
}
S=$(stage 20261103140000)
pnpm exec supabase --workdir "$S" db push --db-url "$DB_URL" --dry-run   # must list exactly the new migration(s)
pnpm exec supabase --workdir "$S" db push --db-url "$DB_URL"
```

Each migration runs in its own transaction: a failure changes nothing and leaves the previous version in place.

## 5. Control SQL

Each is ONE statement, so it works with `supabase db query`. The claims are set inside the same statement, so the audit actor is the owner.

```
-- maintenance ON
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance(jsonb_build_object('enabled', true, 'reason', 'OPS-01B slice 1 release window', 'release_ref', '$RELEASE_REF')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- bypass ON for the owner, 60 minutes
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance_bypass(jsonb_build_object('user_id', '$OWNER_ID', 'minutes', 60, 'reason', 'Operator smoke of $CANDIDATE_SHA')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- bypass OFF
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance_bypass(jsonb_build_object('user_id', null, 'reason', 'Operator smoke finished')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- maintenance OFF (also removes any bypass)
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance(jsonb_build_object('enabled', false, 'reason', 'Candidate healthy; reopening', 'release_ref', '$RELEASE_REF')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
```

Verification SQL (read-only; run as often as needed):

```
-- V1: migration version
select count(*) as applied, max(version) as latest from supabase_migrations.schema_migrations;
-- V2: maintenance state
select enabled, enabled_at, release_ref, bypass_user_id, bypass_expires_at, bypass_expires_at > now() as bypass_live from private.system_maintenance;
-- V3: every write RPC is guarded (must return 0 rows)
select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
  and p.prosrc not like '%perform private.assert_not_in_maintenance();%';
-- V4: the Storage policy carries the guard (must be true)
select with_check like '%maintenance_write_allowed%' from pg_policies where schemaname = 'storage' and policyname = 'expense_receipts_shop_insert';
-- V5: maintenance audit trail
select created_at, action, actor_id, reason, metadata from public.audit_events where entity_type = 'system_maintenance' order by created_at;
-- V6: nothing business-shaped was written during the window (compare with the baseline)
select (select count(*) from public.invoices) inv, (select count(*) from public.payments) pay, (select count(*) from public.expenses) exp,
  (select count(*) from public.customers) cus, (select count(*) from public.corrections) cor, (select count(*) from public.daily_closes) dc,
  (select count(*) from storage.objects where bucket_id = 'expense-receipts') receipts;
```

## 6. Firewall commands

```
# lock (exception for the operator IP)
vercel firewall rules add "ShopKhata maintenance" \
  --condition '{"type":"host","op":"eq","value":"shopkhata.vercel.app"}' \
  --condition '{"type":"path","op":"eq","neg":true,"value":"/api/health"}' \
  --condition "{\"type\":\"ip_address\",\"op\":\"eq\",\"neg\":true,\"value\":\"$OPERATOR_IP\"}" \
  --action deny --yes --scope muzzammels-projects
vercel firewall diff --scope muzzammels-projects       # exactly one added rule
vercel firewall publish --yes --scope muzzammels-projects
vercel firewall rules inspect "ShopKhata maintenance" --json --scope muzzammels-projects   # active: true, three conditions
# operator IP changed: rules edit with all three conditions again, then publish
# unlock
vercel firewall rules remove "ShopKhata maintenance" --yes --scope muzzammels-projects && vercel firewall publish --yes --scope muzzammels-projects
```

Firewall probe (run from a network that is NOT the operator's, e.g. a second device off the hotspot, or a cloud shell):

```
for p in / /login /closing /api/health /api/health/ "/api/health?x=1"; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' "https://shopkhata.vercel.app$p")"; done
# expected: 403 403 403 200 200 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://shopkhata.vercel.app/   # 403
```

From the operator IP the same pages return 200/307 (normal app behaviour).

## 7. State machine

| State | Firewall | DB maintenance | Bypass | DB | App on canonical |
|---|---|---|---|---|---|
| 0 Normal | off | (not installed) | — | 35 | e4f4cfe |
| 0b Guard installed | off | off | off | 36 | e4f4cfe |
| 1 Locked | ON | ON | off | 36 | e4f4cfe |
| 2 Migrating | ON | ON | off | 37 → 38 → 39 | e4f4cfe |
| 3 DB verified | ON | ON | off | 39 | e4f4cfe |
| 4 Operator verification | ON | ON | ON (owner, ≤ 60 min) | 39 | candidate |
| 5 Reopen | off | off | off | 39 | candidate |

Migration 36 is applied with traffic open (State 0b) because it changes nothing until maintenance is enabled, and the guard has to exist before maintenance can be switched on.

## 8. Procedure

### Before the window

1. Candidate commit's CI is green; the candidate is staged with `vercel deploy --prod --skip-domain --env SHOPKHATA_RELEASE=$CANDIDATE_SHA` from a clean worktree. Record its `dpl_` id. Its `/api/health` (through Vercel Auth) shows `$CANDIDATE_SHA`.
2. Record the rollback target: the current canonical `dpl_` id (`vercel inspect shopkhata.vercel.app`) and `/api/health` release.
3. Backup and verify (deployment.md §1–2): `pnpm backup:db`, then `pnpm backup:verify --from <folder>` must end `RESTORE VERIFIED`.
4. Baseline: run V1 (must be 35 / `20261031165915`), V6, and the fingerprint `pnpm exec supabase db query --db-url "$DB_URL" -f scripts/backup-fingerprint.sql --output-format json`. Save the outputs to the release log.
5. Tell staff the system will be unavailable for the window.

### State 0 → 0b: install the guard (traffic open)

6. `S=$(stage 20261103140000)`; dry-run must list only `20261103140000`; push.
7. V1 = 36; V2 = `enabled false`; V3 = 0 rows; V4 = true. Probe the old app on canonical: Dashboard and a sale save work (the guard is transparent while off).
   - **Failure:** push failed → nothing changed (still 35); stop the release, normal operation continues.

### State 1: lock

8. Publish the firewall rule (§6). Run the firewall probe from a non-operator network: pages 403, health 200.
9. Maintenance ON (§5). Result `changed: true, enabled: true`. V2 `enabled true`. V5 shows `maintenance.enabled` with the release ref.
10. Direct-backend check: with an ordinary account, an RPC write returns `MAINTENANCE_ACTIVE` (for example from the browser console of a staff session opened earlier, or `curl` against `/rest/v1/rpc/create_customer` with that session's token).
    - **Failure** (rule not live, or maintenance not on): stay here; do not start migrations until both are proven.

### State 2: migrate 37 → 38 → 39

11. `S=$(stage 20261103150000)`; dry-run lists only `20261103150000`; push. V1 = 37; V3 = 0 rows (it now includes `void_invoice`).
12. `S=$(stage 20261103190000)`; dry-run lists only `20261103190000`; push. V1 = 38.
13. `S=$(stage 20261103203806)`; dry-run lists only `20261103203806`; push. V1 = 39.
    - **Failure at any push:** that migration rolled back; V1 shows the previous version. Both controls stay ON. Read the error and fix the cause (e.g. a dependent object), then re-run the same step. If it cannot be fixed in the window, see §9 "Abort".

### State 3: verify the database

14. V1 = 39 / `20261103203806`. V2 still `enabled true`, no bypass. V3 = 0 rows. V4 true. V6 equals the baseline (no business writes happened).

### State 4: operator verification

15. Re-check `OPERATOR_IP` from the smoke network; edit the rule if it changed.
16. Bypass ON for `$OWNER_ID`, 60 minutes (§5). V5 shows `maintenance.operator_bypass_enabled` with `expires_at`.
17. Promote the staged candidate (no rebuild): `vercel promote <candidate dpl_> --scope muzzammels-projects --yes`. Poll `https://shopkhata.vercel.app/api/health` until `release` = `$CANDIDATE_SHA` (alias swap takes 0–6 s). `vercel inspect shopkhata.vercel.app` shows the candidate `dpl_` id.
18. Operator smoke on **canonical** `https://shopkhata.vercel.app` from the operator IP, signed in as the owner: Dashboard loads; Sales report loads (business-date totals); save one sale; record a payment on it; view the invoice detail; void it (reason ≥ 10 characters) if voiding is part of the agreed smoke; open Daily Close for today (do not close it). Record every reference created.
19. Ordinary-user check during smoke: from a non-operator network the canonical pages are still 403; a staff session's direct RPC write is still `MAINTENANCE_ACTIVE`.
    - **Promotion failure:** canonical never shows the candidate → `vercel promote` again; if it still fails, controls stay ON; see §9.
    - **Smoke failure:** controls stay ON. Bypass OFF. Decide: fix forward (new candidate, repeat 16–18) or abort (§9). Never reopen with a failed smoke.

### State 5: reopen (order matters)

20. Smoke PASS recorded.
21. Bypass OFF (§5). V2 shows no bypass; V5 shows `maintenance.operator_bypass_disabled` (`cause: revoked`).
22. Maintenance OFF (§5). Result `changed: true, enabled: false`. V2 `enabled false`. V5 shows `maintenance.disabled`.
    - **Failure** (error, timeout or uncertain result): the firewall stays ON. Re-run V2 until it gives a definite answer, and re-run step 22 if needed (it is idempotent). Never remove the firewall while V2 is uncertain or `enabled true`.
23. From the operator IP, a write as a non-bypass session (e.g. the manager account) succeeds; a direct receipt upload succeeds.
24. Remove the firewall rule and publish (§6). Probe from a non-operator network: `/` and `/login` are 200/307, not 403.
25. First normal requests: staff open the app, save the first real sale; V6 moves only by what staff entered.
26. Final: `/api/health` = `$CANDIDATE_SHA`; fingerprint taken; release log closed.

Why this order: the bypass goes first so the operator's write in step 23 proves the general path, not the bypass. The database opens before the firewall, so at no point is the app reachable while the database still refuses writes from a session it should accept. The reverse (firewall first) would let staff in to an app whose every save fails. The firewall is the last control removed because it is the only one that also blocks reads of old-app screens.

## 9. Failure states

| Failure | State left | Controls | Action |
|---|---|---|---|
| 36 push fails | 35, old app | none needed | Stop; normal operation. |
| Failure after 37 | 37, old app (Dashboard/Sales report broken) | firewall ON, maintenance ON | Nobody can write or reach the app. Fix and continue to 38, or abort. |
| Failure during 38 or 39 | previous version (transaction rolled back) | both ON | Fix the cause, re-run the same push. |
| Candidate promotion fails | 39, old app | both ON | Retry promote; else abort. |
| Candidate smoke fails | 39, candidate | both ON, bypass OFF | Fix forward or abort. |
| Maintenance disable fails / uncertain | 39, candidate | firewall ON | Re-check V2, retry step 22. Never reopen traffic on an uncertain state. |

**Abort (rollback):** the old app `e4f4cfe` cannot run correctly on 37+ (and migrations are forward-only). Rolling the app back is only useful with a database restore. With both controls ON: restore the database from the verified backup taken in step 3 (backup-restore.md), confirm V1 = 35, `vercel promote <rollback dpl_>`, check `/api/health`, then remove the firewall rule. After a restore the maintenance table no longer exists (it came with 36), so there is no DB maintenance to switch off.

## 10. Release log checklist

Copy into the release log and fill in during the window.

```
[ ] Candidate SHA / staged dpl_ / CI run:
[ ] Rollback dpl_ / release:
[ ] OPERATOR_IP (checked at start / before smoke):
[ ] Backup folder + RESTORE VERIFIED time:
[ ] Baseline V1 / V6 / fingerprint sha256:
[ ] 36 applied (time), V1/V2/V3/V4:
[ ] Firewall published (time), probe results:
[ ] Maintenance ON (time), audit row id:
[ ] Direct RPC refusal seen (account, RPC, message):
[ ] 37 applied (time), V1, V3:
[ ] 38 applied (time), V1:
[ ] 39 applied (time), V1:
[ ] DB verified: V1 / V2 / V3 / V4 / V6 = baseline:
[ ] Bypass ON (time, expires_at):
[ ] Promoted (time), canonical dpl_, /api/health release:
[ ] Smoke steps + references created:
[ ] Non-operator still blocked during smoke (firewall probe, RPC refusal):
[ ] Bypass OFF (time):
[ ] Maintenance OFF (time), V2:
[ ] Non-bypass write OK from operator IP:
[ ] Firewall removed (time), probe:
[ ] First staff sale (time):
[ ] Final /api/health + fingerprint:
```

## 11. Rehearsal record (2026-11-04)

Run on the local Supabase stack with the exact §4/§5 commands (`DB_URL` = local, `OWNER_ID` = seed owner), with a probe that signs in as owner, manager and staff through the real Data API and Storage API and calls `submit_batch`, `create_customer`, `create_expense`, `record_payment`, `close_business_date`, `void_invoice`, `request_invoice_correction` and a receipt upload. `M` = `MAINTENANCE_ACTIVE`, `R` = Storage RLS refusal.

| Step | V1 | V2 | Probe (owner / manager / staff) | V6 |
|---|---|---|---|---|
| State 0 | 35 | — | all writes reach the RPC (OK or normal business error); `void_invoice` not yet defined | — |
| 36 pushed (dry-run listed only 36) | 36 | off | identical to State 0: the guard is transparent | — |
| Maintenance ON | 36 | on | every write `M`, every upload `R`; reads OK | baseline |
| Enable repeated | 36 | on | — | V5 still one `maintenance.enabled` |
| 37 pushed | 37 | on | every write `M` **including the new `void_invoice`**, uploads `R` | = baseline |
| 38 pushed | 38 | on | same | = baseline |
| 39 forced to fail (a view depending on `report_sales_totals`) | 38 | on | same; 39's alias absent: the transaction rolled back | = baseline |
| Blocker removed, 39 re-pushed | 39 | on | — | = baseline |
| DB verified | 39 | on, no bypass | V3 none unguarded, V4 true | = baseline |
| Bypass ON (owner, 60 min) | 39 | on, bypass live | owner writes and upload OK; manager and staff still `M`/`R` | — |
| Candidate smoke (local build of the candidate, `next start`) | | | owner saves a sale; Dashboard, Sales report and Daily Close render without an error page; a staff sale in the same state shows "ShopKhata is being updated" and keeps the draft | — |
| Bypass OFF | 39 | on | owner back to `M`/`R` | — |
| Maintenance OFF (and repeated: no-op) | 39 | off | all three roles write and upload normally | — |
| Smoke after reopen | | | owner and staff sales both saved | — |

Audit trail at the end (V5): `maintenance.enabled`, `maintenance.operator_bypass_enabled`, `maintenance.operator_bypass_disabled (revoked)`, `maintenance.disabled`.

**Firewall (disposable Vercel project, deleted afterwards).** The §6 rule shape (host, `path neq /api/health`, `ip_address neq <IP>`, deny) was published on a throw-away project and alias:

- With the exception set to another IP, from this machine: `/` 403, `/api/dashboard` 403, `POST /api/dashboard` 403, `/api/healthz` 403, `/api/health/../dashboard` 403, `/api/health%2F..%2Fdashboard` 403; `/api/health`, `/api/health/`, `/api/health?x=1` and `/api/%68ealth` 200; `/API/HEALTH` 404 (passes the rule, matches no route); `//api/health` 308; the deployment host 302 to Vercel Authentication.
- With the exception set to this machine's IP: `/`, `/api/dashboard`, `POST /api/dashboard` and `/api/health` all 200.
- Earlier rehearsal (same rule without the IP condition): live about 1 s after publish, holds across promote and rollback, alias swap 0–6 s.

**Already-open tabs** (`tests/e2e/maintenance.spec.ts`, candidate app): a sale, a payment, an expense and a Daily Close, each filled in and reviewed before maintenance started, are refused by the database when submitted afterwards without a reload; nothing is written; the sale draft stays on the device and saves from the same tab after reopen. Old-app tabs (e4f4cfe) reach the database only through Server Actions, which the firewall blocks, plus the direct receipt upload, which the Storage policy blocks.

**Not rehearsed here:** the production database and the production Vercel project (out of scope by design); the Supabase CLI's handling of a production URL is the same command already used for every production migration.
