# OPS-01B slice 1 — maintenance release runbook

The production release of OPS-01B slice 1 (maintenance guard, invoice void, historical-sales remediation, sales-RPC release compatibility) behind a two-layer maintenance boundary. Read it end to end before starting. Every step names the command, what it must print, and what to do if it does not.

This runbook is the reviewed procedure. **Do not improvise in the window.** If a check fails, take the failure branch written next to it. Anything not covered is a STOP.

## 1. What the release contains

| # | Migration | Effect |
|---|---|---|
| 35 | `20261031165915_ops_01a_shop_user_status_controls.sql` | **Production today** (35 migrations). Not part of this release. |
| 36 | `20261103140000_ops_01b_maintenance_guard.sql` | Maintenance state, write guard on every business RPC, Storage receipt guard (trigger), owner control RPCs, the owner-only receipt restore context (disaster recovery into a locked database). No behaviour change while maintenance is off. |
| 37 | `20261103150000_ops_01b_invoice_void.sql` | `void_invoice` (guarded from its first statement). |
| 38 | `20261103190000_ops_01b_void_remediation.sql` | Business-date sales movements; `report_sales_totals` new shape. |
| 39 | `20261103203806_ops_01b_sales_totals_release_compat.sql` | `report_sales_totals.effective_total_dirham` restored as a deprecated alias of net sales. |

Production before the release: 35 migrations (last `20261031165915`), app `e4f4cfe` (`dpl_8BXn…` or whatever §4.2 records). Candidate app: the commit that contains this runbook.

The old app on a database at 37 or 38 shows wrong numbers or error pages (the Dashboard and Sales report fail at 37). That is why traffic stays closed from before 37 until the candidate is serving and smoked. The old app on a database at 36 is unaffected (the guard is transparent while maintenance is off).

## 2. The boundary

Two independent controls. Both must be on for every state between "locked" and "reopen".

**Vercel Firewall (app traffic).** One custom rule on project `shopkhata`:

- `host eq shopkhata.vercel.app` AND `path neq /api/health` AND `ip_address neq <OPERATOR_IP>` → `deny` (403).
- Live about 1 s after `publish`; survives promote and rollback (rehearsed 2026-11-04).
- Blocks pages, RSC requests, Server Action POSTs, API routes and static assets for everyone except the operator's IP. Deployment hosts (`shopkhata-<hash>-…vercel.app`) are behind Vercel Authentication and are not used.
- The rule matches **one host**. That is only a complete boundary if `shopkhata.vercel.app` is the only public host (§4.2 proves it; any custom domain is a STOP).
- `/api/health` stays reachable. It is a GET-only route that reads two environment variables and returns `{status, release}`; it makes no database call and returns no business data. Rehearsed variants: `/api/health`, `/api/health/`, `/api/health?x=1` and `/api/%68ealth` reach the health route; `/API/HEALTH` passes the firewall (its path match ignores case) but Next routes and the proxy's health exemption are case-sensitive, so the app treats it as an unknown path and no business route is reachable; `/api/health/../dashboard`, `/api/health%2F..%2Fdashboard` and `/api/healthz` are denied.

**Database maintenance (direct Supabase traffic).** Migration 36 adds:

- `private.system_maintenance`: one row. No API role can read or write it. Structural CHECK constraints make an inconsistent state unrepresentable:
  - *enabled* ⇒ `enabled_at`, `enabled_by` and a non-blank `reason` are all set (`release_ref` is optional, but when present it is trimmed, 1–200 characters; the runbook always sets it);
  - *disabled* ⇒ `enabled_at`, `enabled_by`, `reason` and `release_ref` are all NULL (no stale metadata);
  - the **bypass** is one all-or-nothing group: `bypass_user_id`, `bypass_expires_at`, `bypass_enabled_by` and a non-blank `bypass_reason` are all set or all NULL, and a bypass can only exist while maintenance is enabled;
  - the table holds exactly one row (`id boolean primary key check (id)`). If that row is ever missing, the control RPCs raise `MAINTENANCE_STATE_MISSING` (nothing is written, no audit row), and every guard **fails closed** (`MAINTENANCE_ACTIVE`).
- `private.assert_not_in_maintenance()`: the first statement of all 24 business write RPCs, with no declaration initializer before it. While maintenance is on it raises `MAINTENANCE_ACTIVE`, before validation, locks or writes.
- A `BEFORE INSERT` trigger on `storage.objects` for the `expense-receipts` bucket carries the same decision for direct browser uploads. See "Why Storage is a trigger" below.
- `public.set_maintenance({enabled, reason, release_ref?})` and `public.set_maintenance_bypass({user_id|null, minutes 1–120, reason})`: active owner only, reason required, audited in `audit_events` as `maintenance.enabled`, `maintenance.disabled`, `maintenance.operator_bypass_enabled`, `maintenance.operator_bypass_disabled`.
  - Enable, disable and revoke are **idempotent**: a repeat returns `changed: false` and writes no audit row.
  - A bypass **grant is a renewal, not idempotent.** Granting while a bypass exists (same or another owner) replaces the single operator slot with a fresh expiry and writes a new `operator_bypass_enabled` audit row with `renewal: true` and the previous holder and expiry. Use it to extend a smoke that is running late.
  - Disabling maintenance also clears any bypass and audits `operator_bypass_disabled` with `cause: maintenance_disabled` and the window's `release_ref` (an explicit revoke has `cause: revoked`).
- **Operator bypass:** one active owner account, for at most 120 minutes (the runbook uses 60). While valid, that owner's own writes pass the maintenance guard and nothing else changes: role, shop status, closed dates and every other RPC check still apply. Managers and staff can never hold it.
- **Expiry semantics.** A bypass is judged on the **wall clock** (`clock_timestamp()`), after the decision has the lock, not at transaction start (`now()`); a grant measures its minutes from the moment it acquired the lock. Expiry is an *admission* boundary: a write admitted a moment before expiry may commit after it. An explicit revoke or disable is a *hard* barrier (below).

### Lock contract

One global order **for the application-controlled business and database locks**: a path that needs several of these takes them in this order and never the reverse. (This is not a claim about locks outside the application: the Supabase Storage service may already hold its own object-level, advisory or row locks for an upload before that upload's final `storage.objects` INSERT reaches the L1 trigger. The maintenance controls never acquire any of those Storage locks, so they cannot form a cycle with them; the reviewed lock analysis and the Storage race tests in §12 found no cycle.)

| Lock | What | Taken by |
|---|---|---|
| **L1** | the single `private.system_maintenance` row | `FOR SHARE`: every business write RPC (first statement) and every `expense-receipts` Storage insert, held until that transaction ends. `FOR UPDATE`: `set_maintenance` and `set_maintenance_bypass` (enable, disable, grant, renew, revoke), as their first lock. |
| **L2** | advisory lock `account-administration` | the admin RPCs and the two control RPCs, after L1 |
| **L3** | everything else (per-shop and idempotency advisory locks, invoice and ledger row locks) | after L1 and L2 |

What it guarantees:

- A control transition **waits** for every write or upload admitted before it, and reports success only after they committed or rolled back. No write commits after a reported activation, and no bypass write commits after a reported revocation.
- A write that starts after the transition commits re-reads the row and refuses; one that starts while a transition is queued waits behind it, then refuses.
- Among the application's locks, L1 is never requested while L2 or L3 is held, so the admin path (L1 then L2) and the control path (L1 then L2) cannot deadlock. A Storage upload may reach L1 while holding Storage-internal locks; nothing that holds L1 ever waits for a Storage-internal lock. The controls reject non-owners **before** queueing for L1 (a cheap unlocked check), so no ordinary user can stall writes by calling them.

### Why Storage is a trigger, not a policy

The browser uploads receipts straight to Storage. The Storage service (inspected in the local stack's `storage-api` 1.80.2) checks the INSERT policy inside a **throw-away transaction it always rolls back**, then uploads the bytes, then commits the real `storage.objects` row in a **second transaction** from a service-role connection that has no RLS. A lock taken inside a policy is released at the first rollback, long before the object commits, so it would serialize nothing: an upload admitted while maintenance was off could commit after maintenance was reported active. A `BEFORE INSERT` trigger fires in **both** transactions, in particular the one that commits the row, so its share lock on L1 is held through that commit. The uploader is identified by `NEW.owner_id` (set by Storage from the verified JWT subject); the connection's own claims are only `{"role":"service_role"}`. The existing INSERT policy is unchanged. A refused upload fails in the permission test before any bytes are sent; one admitted earlier and refused at the final insert leaves no `storage.objects` row, and Storage deletes the bytes it had already written (verified in the rehearsal). Update and delete stay denied to every API role by the existing policies, so insert is the only user-reachable Storage mutation. If the hosted Storage service ever stopped setting `owner_id`, the guard would treat the upload as uploader-less and refuse it while maintenance is on (fail closed), never admit it.

**Receipt restore context (disaster recovery only).** A restored database can come up locked (by design), and a restore puts receipt bytes back with the service key, whose uploads carry no uploader, so the guard refuses them. Migration 36 therefore also adds `private.receipt_restore_objects` and `private.receipt_restore_open(ref, names[], minutes ≤ 60)` / `private.receipt_restore_close(ref)`: while maintenance blocks an insert, the trigger admits it only if it has **no uploader** (`owner_id` NULL; an authenticated user's upload always carries its own id), its exact object name is **listed**, and the listing has **not expired**. It is not a service-role exemption: any other service-key upload is still refused. The functions have no API grant (database-owner connection only), every open/close is logged in `private.receipt_restore_log`, and `scripts/backup.mjs` opens it for exactly the backup's object names and always closes it (it fails if anything is left listed). The post-36 gate (P10) requires it to be empty. **It exists only inside one maintenance period:** `receipt_restore_open` takes the L1 lock first and refuses with `MAINTENANCE_NOT_ACTIVE` unless maintenance is ON (`MAINTENANCE_STATE_MISSING` if the singleton is gone), so it is ordered strictly before or after any enable/disable; every listing records the `enabled_at` of the period it was opened in and admits nothing in any other period; and maintenance OFF deletes any open context (logged `cleared` in `private.receipt_restore_log`). A restore process that dies without closing therefore leaves nothing usable after an OFF → ON transition. `backup.mjs` opens the context only for a LOCKED restored database (an unlocked one needs none).

Reads (tables, views, report RPCs) are not blocked by the database. RLS still scopes them to each user's own shops, so a user who calls the Data API directly sees only data they can already see. The firewall keeps the app's report screens closed during the window.

**Who is exposed to what during the window:**

| Path | Ordinary users | Operator (bypass on, operator IP) |
|---|---|---|
| App pages, Server Actions, API routes | 403 (firewall) | allowed |
| Direct RPC writes (any of 24) | `MAINTENANCE_ACTIVE` | allowed within the owner role |
| Direct Storage receipt upload | refused, no object | allowed |
| REST table INSERT/UPDATE/DELETE | refused (no grant, ever) | refused |
| Direct reads (REST/report RPCs) | own shops only (RLS) | owner |
| Existing signed receipt URLs | readable until expiry (300 s); read-only | — |
| GraphQL, Realtime, Edge Functions | verified absent or non-mutating by the inventory gate (§4.1) | — |
| `service_role` key / direct database connections | **not governed by the guard.** Not held by users; the inventory gate lists the only grant (`backup_records` insert) and the quiescence check (W5) must show no such session | — |

## 3. Variables for the window

Keep these in a password manager or the shell session, never in a file in the repository.

```
DB_URL=<production session-pooler URI, NO password> # project ref karvhrylmogxxfegubnc; password in PGPASSWORD; how: §3.1
OWNER_ID=<owner auth user id>                    # select id from public.profiles where role = 'owner' and is_active
OPERATOR_IP=<the operator's public IP>           # curl -s https://api.ipify.org
CANDIDATE_SHA=<full candidate commit>
RELEASE_REF=ops-01b-slice1-$CANDIDATE_SHA
EVIDENCE=<a folder outside the repository>       # every output below is saved here
```

### 3.1 The migration connection (`DB_URL` + `PGPASSWORD`) — one connection path, role and credential class for the preflight and for migration 36

Every `supabase` CLI invocation opens its **own** PostgreSQL connection and session; nothing here shares a session between the preflight and the push. What C13c proves is a property of the **connection path, role and credential class**: it runs as the role reached through `$DB_URL` (session pooler, user `postgres.karvhrylmogxxfegubnc` → role `postgres`) and checks that this role has every catalog prerequisite of migration 36. The inventory gate (§4.1), every `db push` and every control/verification statement therefore use the **same `$DB_URL` and the same password**, set once in one operator shell, so each of their separate sessions is the same role over the same path. C13c's recorded `current_user`/`session_user` must equal those of the post-36 gate (P03's run, W2b). `supabase db query --linked` is **not** a substitute: in CLI 2.121.0 it "queries the linked project's database via Management API" (`db query --help`), a different path and role context from the Postgres connection that pushes 36 (P1 2026-11-05 used it because `$DB_URL` was not set; that run cannot satisfy C13c). **C13c therefore remains a mandatory requirement of the repeated production P1.**

1. Supabase dashboard → project `shopkhata-prod` (`karvhrylmogxxfegubnc`) → **Connect** → **Session pooler** (session mode, port 5432; not the transaction pooler on 6543, which cannot run migrations). The URI's user is `postgres.karvhrylmogxxfegubnc` (the `postgres` role). The database password is in the owner's password manager; if it must be reset, do that in the dashboard *before* the release day, never during the window.
2. **The password never goes on a command line.** `--db-url` is a process argument: on this path it is visible in the process list twice (the `pnpm`/node launcher re-spawns `supabase.exe` with the same arguments). So `$DB_URL` is the session-pooler URI **without** the password (`postgresql://postgres.karvhrylmogxxfegubnc@<pooler host>:5432/postgres`; user, host and port are not secret), and the password is supplied through the libpq-standard `PGPASSWORD` environment variable, which the installed CLI's Postgres driver reads when the URI has no password. In a dedicated Git Bash window used only for the release: `export DB_URL='postgresql://postgres.karvhrylmogxxfegubnc@<pooler host>:5432/postgres'`, then `read -rs PGPASSWORD && export PGPASSWORD` and paste the password (no echo, not in history). Never put the password in a file, `.env*`, a URI, a command argument, the evidence folder or a chat; do not use `--debug`. Do **not** use `SUPABASE_DB_PASSWORD` or `--password`/`-p`: with `--db-url` and a remote host CLI 2.121.0 ignores `SUPABASE_DB_PASSWORD` ("password must be a string"), and `-p` is itself a process argument. A password with special characters needs no percent-encoding in `PGPASSWORD`.
   - Verified locally only (P1C, 2026-11-06, CLI 2.121.0, the CLI's *remote* connection path against the local database via its LAN address with `sslmode=disable`, which production must NOT use): `db query`, `migration list` and `db push --dry-run` connect with a password-less `--db-url` + `PGPASSWORD`, fail with `28P01` when `PGPASSWORD` is wrong, and `SUPABASE_DB_PASSWORD` is not honored. Not tested against production (no credential was obtained).
   - **Residual exposure (accurate, not "never exposed"):** `PGPASSWORD` is in the environment of that shell and of every process it starts until it is unset. Environments are readable by the same OS user and by administrators (not by other unprivileged users, unlike command lines). Bounded mitigation: a dedicated shell window for the window only, no other tools or browsers launched from it, no `env`/`set`/`printenv`/`--debug` in it, `unset PGPASSWORD DB_URL` and close it as soon as the last database step is done; if the password could have been exposed, rotate it in the dashboard after the window.
3. Check it without printing it: `pnpm exec supabase db query --db-url "$DB_URL" "select current_user, session_user, current_setting('server_version')"` → `postgres`, `postgres`, 17.x. Then run the §4.1 commands **in the same shell**. The preflight's `evidence.session` (and C13c's `current_user`/`session_user`) is the release identity of this connection path; record it and compare it with every later gate's `session` block.
4. Before saving any output to `$EVIDENCE`, check stderr for connection details (a failed connection can echo the host and user; it cannot echo a password that is not in the URI — if anything credential-like appears anyway, redact it before saving).
5. After the window: `unset PGPASSWORD DB_URL` and close the shell.

`OPERATOR_IP` must be a network no staff member shares (use a phone hotspot, not the shop Wi-Fi). Check it from the network you will smoke from, and again before the bypass: mobile IPs change. If it changes during the window, edit the firewall rule (§6) before continuing.

Vercel commands run from a folder linked to project `shopkhata` (copy `.vercel/project.json` only) with `--scope muzzammels-projects`. In Git Bash set `MSYS_NO_PATHCONV=1`.

## 4. Pre-maintenance production inventory gate (MANDATORY, before the window)

Everything in this section is **read-only** and happens **before** the release window opens. Save the raw output of every command in `$EVIDENCE`. The expected values are what the OPS-01B migrations were reviewed against; this gate checks the real production against them. **Any STOP means the release does not start** — find out why production differs, and re-review before trying again. There is no "continue anyway".

### 4.1 Supabase (hosted production)

```
# C01-C23 (26 checks): version, migrations, absent OPS-01B objects, RPC signatures/grants/bodies, effective mutation rights (incl. PUBLIC),
# views, RLS, Storage shape/policies/triggers/privileges of THIS connection path's role, Realtime, triggers, cron/webhooks, exposed schemas,
# and the maintenance authorization dependencies (C23).
# One JSON document: verdict PASS or STOP, plus recorded evidence. Use the SAME $DB_URL that will push migration 36.
pnpm exec supabase db query --db-url "$DB_URL" -f scripts/ops-01b-preflight.sql --output-format json > "$EVIDENCE/preflight-supabase.json"
node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[0].preflight;console.log(p.verdict);for(const c of p.checks.filter(c=>!c.ok))console.log('STOP',c.id,JSON.stringify(c.got));console.log(JSON.stringify(p.evidence,null,1));console.log(p.manual.join('\n'))" "$EVIDENCE/preflight-supabase.json"
# Exact applied migrations: the Local and Remote columns must agree for all 35; the four new versions are Local only.
pnpm exec supabase migration list --db-url "$DB_URL" > "$EVIDENCE/migration-list.txt"
# Edge Functions: must be empty.
pnpm exec supabase functions list --project-ref karvhrylmogxxfegubnc > "$EVIDENCE/edge-functions.txt"
```

The script's checks:

| ID | Verifies | STOP if |
|---|---|---|
| C01 | PostgreSQL major version 17 | not 17 |
| C02 | exactly the 35 reviewed migrations, last `20261031165915` | any other count, version or order |
| C03 | none of the OPS-01B objects exist yet (maintenance table and functions, `void_invoice`, `invoice_voids`, the Storage trigger, moved bodies) | any exists (a half-applied release) |
| C04 | the API role executes exactly the 23 reviewed write RPCs and 9 reports, same signatures and grants | an extra, missing or re-granted function (an unexpected write RPC) |
| C05 | the 32 function bodies (canonical line endings, see below), owners, security-definer flags and `search_path` are identical to the reviewed ones (migration 36 moves them unchanged) | any drift |
| C06 | `anon`, `service_role` and `PUBLIC` execute no public function | any |
| C07 | no volatile function is offered to `anon`/`authenticated` from a schema outside the Supabase-owned ones and `public`/`graphql_public` (those two: C04, C21) | any |
| C08 | **effective** direct mutation rights of `anon`, `authenticated` and `service_role` — `has_table_privilege`/`has_sequence_privilege`, so grants to `PUBLIC` and through role membership count (unlike `information_schema.role_table_grants`) — for INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on every table, view, materialized view and foreign table, and USAGE/UPDATE on every sequence, in every schema outside the Supabase-owned ones: only `service_role` INSERT on `backup_records` | anything else |
| C09 | RLS enabled on every public table | any table without |
| C10 | the 24 public RLS policies are the reviewed ones | any change |
| C11 | the only Storage bucket is private `expense-receipts` with the reviewed limits | another bucket, or a changed limit |
| C12 | `storage.objects` has exactly the four reviewed `expense_receipts_*` policies, unchanged | a differing policy |
| C13a | `storage.objects` has `id uuid`, `bucket_id text`, `name text`, `owner_id text` (what the guard and the restore context read) | a missing column or another type |
| C13b | every trigger on `storage.objects` runs `storage.*` code and is enabled; the guard's name is free (also C03) | a foreign or disabled trigger |
| C13c | **the role of this connection path** (= the migration path: same `$DB_URL`, same role, same credential class; each CLI call is its own session) has every catalog prerequisite of migration 36: TRIGGER on `storage.objects`, USAGE on `storage`, CREATE on `private` and `public`, PL/pgSQL installed and usable, EXECUTE on `private.is_valid_uuid_text`, ownership (or membership of the owner) of every write RPC it moves | any missing |
| C14 | Realtime publishes no table | any published table |
| C15 | the 46 application triggers, fingerprinted by table, name, **enabled state**, timing/events, function identity and schema, full `pg_get_triggerdef` and the trigger **function body** (canonical line endings) | an added, changed, re-pointed or edited trigger |
| C15b | no application trigger is disabled | any disabled (named in the output) |
| C16 | no scheduled job and no database webhook | any |
| C17 | exposed API schemas, where stored on the role, are only `public`/`graphql_public` | any other schema |
| C18 | no explicit grant to `PUBLIC` other than SELECT on any application relation (`aclexplode`, grantee 0) | any |
| C19 | no view / materialized view / foreign table is a mutation path for `anon`, `authenticated` or `PUBLIC`: auto-updatable, INSTEAD OF trigger or rule, **and** a write grant | any (named) |
| C20 | the 7 application views are the reviewed ones (name, `security_invoker`, updatability bits, INSTEAD OF triggers, rules). `public.invoice_effective_balances` is auto-updatable and has no write grant: C19 is what keeps it read-only | any change |
| C21 | the only function `anon`/`authenticated` may execute in an exposed schema other than `public` is `graphql_public.graphql(...)` (pg_graphql's entry point; it resolves mutations to the relations and functions C04–C08/C19 cover) | any other |
| C22 | Storage: every storage table `anon`/`authenticated` can write has RLS on, and no storage table other than `objects` has a policy | any |
| C23 | **maintenance authorization dependencies** (P1D): `private.is_owner()` and `private.assert_account_admin()`, which exist before migration 36 and which both control RPCs of migration 36 call, have the reviewed signature, canonical body, security-definer flag, owner and `proconfig`/`search_path` (fingerprint `6676d9f5a8180efcb74c813ecab78c54`, the P03 attribute set); and the `public.profiles` columns `is_owner()` reads (`id`, `role`, `is_active`: type, NOT NULL, generated, identity, default) are the reviewed ones on a plain table (`964a6b4f6c9be934f7f53be7a2f95eb2`) | either function missing or drifted in any attribute (including whitespace), or any of those columns retyped, made nullable, generated or given another default |

The gate has **26 checks** (C01–C23 with C13a/b/c and C15b); all must PASS.

**Canonical body fingerprints (C05, C15, C23, and P03 of the post-36 gate).** A function body is hashed as `regexp_replace(prosrc, E'\r\n?', E'\n', 'g')`: CRLF → LF, then any lone CR → LF. Nothing else is normalized — spaces, tabs, comments, case and every other character stay significant, so any textual change still STOPs. Reason: PostgreSQL stores `prosrc` byte-for-byte as the migration file was materialized by Git (`core.autocrlf`), so the same reviewed migration pushed from an LF or a CRLF checkout gave different raw hashes (P1, 2026-11-05: production C05/C15 STOP; P1A proved all 20 differing bodies and 7 triggers were line-endings-only). The reviewed values (C05 `81a19e9eeb0e97453269b242ac153eae`, C15 `0d7b1051a65dc974e1b7fa20368f38eb`, C23 `6676d9f5a8180efcb74c813ecab78c54`, P03 `178bf849bb844cf50ff82a29fc2bf4b8` since P1D added `private.is_owner()` and `private.assert_account_admin()`; P1C's 10-function value was `a90805db457c021474c8a0ad5e934dd3`, before that `3822757383203729978b7c00aea758bc`) are reproduced from a clean local DB35/DB36; `tests/integration/operations/fingerprint-line-endings.test.ts` proves LF, CRLF, lone-CR and mixed bodies (and databases built from CRLF migration files, through 39) pass, and statement, authorization, trigger and whitespace drifts STOP. Deparsed text (`pg_get_triggerdef`, `pg_policies`, P02) is generated by PostgreSQL and does not depend on the file's line endings; it is not normalized.

**What the canonical rule deliberately equates, and why that is sound.** The canonical fingerprint intentionally treats source-file line endings as equivalent. It is valid only because the reviewed protected definitions contain no intentional CR-sensitive literal-data semantics. Whole-body CR/LF normalization cannot tell a line break between tokens from one *inside* a string literal, where CR and LF would be different runtime data. P1C inspected every body C05, C15 and P03 hash (DB35: the 32 API functions and the 4 trigger functions; DB36: the 10 P03 functions; 1968 literals); P1D extended the same inspection to C23's two bodies at DB35 and P03's 12 at DB36 (38 bodies with 1844 literals at DB35, 12 with 136 at DB36; same result) with a bounded literal lexer (`tests/integration/operations/sql-literals.ts`: quotes, `E''`, dollar quotes, comments; not a parser): **no** literal spans a line break, none produces a CR by escape (`E'\r'`, `\015`, `\x0d`) and none uses `chr(13)`. PostgreSQL's lexer treats CR and LF alike as whitespace and as line-comment terminators, so outside literals they cannot change meaning. `tests/integration/operations/p03-maintenance-controller.test.ts` re-runs this inspection on the gates' own object sets, so a reviewed definition that ever gains a multi-line or CR literal fails the release tests instead of being silently equated. Normalization is limited to CR/LF; nothing else is canonicalized.

The `evidence` block is recorded, not judged: the session (`current_user`, `session_user`, superuser flag, role memberships — locally `postgres` is a member of `anon`, `authenticated` and `service_role`, which is how it holds TRIGGER on `storage.objects`), the owner of `storage.objects` (`supabase_storage_admin`), the Storage service's schema version (`storage.migrations`), the existing BEFORE INSERT triggers on `storage.objects` in firing order, and the event triggers. Compare it with the release log and explain any change. C10/C12 compare deparsed policy text, which depends on the session's `search_path`; a different `search_path` gives a STOP, never a false PASS.

#### What C13 proves, and what it cannot

| Property | How | Proven before W1? |
|---|---|---|
| Identity of the migration role | `current_user`/`session_user` of the gate's own session; the push opens a separate session over the same `$DB_URL` | **Yes, by construction of the path, not of the session** (same connection string and password; the CLI connects as the URL's user, so each separate session has the same role). Run both from the same shell with the same variables; P03's `session` block confirms it after the push. |
| `storage.objects` exists with the columns and types the guard reads (`owner_id text`) | C13a | Yes |
| No conflicting trigger name; existing triggers Storage-owned and enabled | C03, C13b | Yes |
| Table owner | evidence (`supabase_storage_admin`) | Recorded |
| TRIGGER privilege of the **actual** migration role (direct or inherited) | C13c, `has_table_privilege(current_user, …)` | Yes |
| CREATE on `private`/`public`, USAGE on `storage`, PL/pgSQL usable, EXECUTE on the helper, ownership of the moved RPCs | C13c | Yes |
| That the hosted server will actually **accept** `CREATE TRIGGER … ON storage.objects` from this role (platform restrictions, event triggers, hosted-only hooks) | — | **No.** The only way is to run the DDL. A `BEGIN; CREATE TRIGGER …; ROLLBACK` probe is still DDL against production: it takes SHARE ROW EXCLUSIVE on `storage.objects` (blocking uploads) and fires event triggers, so it is **not** part of the read-only gate. |
| That the hosted Storage write path fires the trigger in the transaction that commits the object, with `owner_id` set | — | **No** (hosted Storage version differs from the local one). Proven live at W4 (ordinary upload refused while locked) and fail-closed by design (no `owner_id` ⇒ refused). |

So **migration 36 is itself a controlled bootstrap gate** (W2/W2b): it is applied only with the firewall ON and the preflight PASS, it is verified immediately by `scripts/ops-01b-post36-verify.sql` before anything else happens, and any failure stops the window with the firewall still ON (§10).

**Manual evidence** (the script prints the reminders; record the answer in the release log):

- Edge Functions list is empty (`edge-functions.txt`). A deployed function that mutates business data is a STOP.
- GraphQL: if `pg_graphql` is installed, C08 already proves no table mutation is granted, and its function mutations go through the same guarded RPCs; record that it is installed. If any exposed schema other than `public` is shown in the dashboard (Settings → API), STOP.
- Authentication → Hooks: none that writes business data.
- Network restrictions / pooler settings are unchanged since the last release (record them).

### 4.2 Vercel (production project `shopkhata`)

```
vercel project inspect shopkhata --scope muzzammels-projects > "$EVIDENCE/vercel-project.txt"      # team, project id, framework, Node
vercel project protection --json --scope muzzammels-projects > "$EVIDENCE/vercel-protection.json"  # deployment protection mode
vercel domains list --scope muzzammels-projects > "$EVIDENCE/vercel-domains.txt"
vercel alias list --scope muzzammels-projects > "$EVIDENCE/vercel-aliases.txt"
vercel inspect shopkhata.vercel.app --json --scope muzzammels-projects > "$EVIDENCE/vercel-canonical.json"  # canonical dpl_ id, target, aliases
curl -s https://shopkhata.vercel.app/api/health > "$EVIDENCE/health-before.json"                  # current release SHA
vercel firewall status --json --scope muzzammels-projects > "$EVIDENCE/vercel-firewall-status.json"       # rules in EXECUTION ORDER, managed rulesets, bypass paths
vercel firewall rules list --scope muzzammels-projects > "$EVIDENCE/vercel-firewall-rules.txt"
vercel firewall system-bypass list --scope muzzammels-projects > "$EVIDENCE/vercel-system-bypass.txt"
vercel inspect <candidate dpl_> --json --scope muzzammels-projects > "$EVIDENCE/vercel-candidate.json"
vercel curl /api/health --deployment <candidate dpl_> --scope muzzammels-projects > "$EVIDENCE/health-candidate.json"
```

Verify and record each; **STOP** on any difference:

| Item | Required | STOP if |
|---|---|---|
| Team / project | team `muzzammels-projects`, project `shopkhata`, id `prj_L9sBb9btftpXkXlk12s1oGhyoyql` | different |
| Domains | **no custom domain**; only the `*.vercel.app` hosts | any custom domain (the lock rule matches one host only) |
| Aliases | `shopkhata.vercel.app` is the only alias that serves production; no other anonymous public host | any other alias on a production deployment |
| Canonical | one production deployment; record its `dpl_` id (= rollback target) and that `/api/health` `release` equals the expected current SHA (`e4f4cfe…` today) | health SHA differs from the recorded release |
| Deployment protection | Vercel Authentication on deployment URLs (`all_except_custom_domains` today) | preview/deployment URLs anonymously reachable |
| Bypass credential | none exists that lets an anonymous client skip protection or the firewall: `vercel firewall system-bypass list` empty; no project-level protection-bypass secret, no firewall `allow`/`bypass` rule (record only *whether* such a credential exists — never save its value) | any exists and is not understood |
| Firewall inventory | the rule list from `status` is recorded; **rule order**: custom rules run in the order `status` prints; a new `deny` rule must not sit behind a broader `allow`/`bypass` rule for the same host; managed rulesets and IP blocks are recorded | an earlier rule that would let traffic past the lock, or the order semantics are not as stated above |
| Candidate | `dpl_` id, `target` = production staged with `--skip-domain` (no alias), commit SHA = `$CANDIDATE_SHA`, `/api/health` `release` = `$CANDIDATE_SHA`, CI green on that SHA | any mismatch, or the candidate already has an alias |
| Env | `SHOPKHATA_RELEASE` on the candidate = SHA; Supabase URL = production project | any mismatch |

The pre-window empirical check of the lock rule is not repeated here; W1 proves it live.

### 4.3 Stop conditions (summary — no improvisation)

STOP, and do not enter the window, if **any** of:

- production migration set differs from the 35 reviewed, or any OPS-01B object already exists (C02, C03);
- an unexpected write RPC exists, or a reviewed RPC body/signature/grant differs (C04–C07, C21);
- any effective direct mutation right exists for an API role, including through `PUBLIC` or a writable view (C08, C18, C19), a view changed (C20), RLS is off anywhere (C09, C22), or a policy differs (C10, C12, C22);
- an application trigger was added, changed, re-pointed, edited or disabled (C15, C15b);
- an authorization dependency of the maintenance controls (`private.is_owner()`, `private.assert_account_admin()`, or the `public.profiles` columns `is_owner()` reads) differs from the reviewed one (C23);
- an unexpected Realtime publication, cron job or database webhook exists (C14, C16);
- an Edge Function that mutates business data is deployed;
- the Storage bucket set or any `expense-receipts` policy differs, `storage.objects` has another shape or a foreign/disabled trigger, or the migration role (this connection path) lacks any prerequisite of the Storage trigger (C11–C13c);
- any custom domain, extra production alias or anonymous public host exists, or deployment protection differs (§4.2);
- firewall semantics differ from §2 (order, an earlier allow/bypass), or a bypass credential exists that is not understood;
- candidate SHA, deployment id, target or health release differs from what the release log recorded.

## 5. Applying migrations one at a time

`supabase db push` applies every pending migration. To stop at a given migration, push from a staging folder that holds only the migrations up to that point:

```
stage() {   # stage <last migration version>
  S="$(mktemp -d)"; mkdir -p "$S/supabase/migrations"; cp supabase/config.toml "$S/supabase/"
  for f in supabase/migrations/*.sql; do v="$(basename "$f" | cut -d_ -f1)"; [ "$v" \> "$1" ] || cp "$f" "$S/supabase/migrations/"; done
  echo "$S"
}
S=$(stage 20261103140000)
pnpm exec supabase --workdir "$S" db push --db-url "$DB_URL" --dry-run   # must list exactly the one new migration
pnpm exec supabase --workdir "$S" db push --db-url "$DB_URL"
```

Each migration runs in its own transaction: a failure changes nothing and leaves the previous version in place.

## 6. Control SQL, verification SQL and firewall commands

### Control SQL

Each is ONE statement, so it works with `supabase db query`. The claims are set inside the same statement, so the audit actor is the owner. (On Windows put the statement in a file and use `-f`; `cmd.exe` mangles the quotes in an argument.)

```
-- maintenance ON
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance(jsonb_build_object('enabled', true, 'reason', 'OPS-01B slice 1 release window', 'release_ref', '$RELEASE_REF')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- bypass GRANT (or RENEWAL) for the owner, 60 minutes
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance_bypass(jsonb_build_object('user_id', '$OWNER_ID', 'minutes', 60, 'reason', 'Operator smoke of $CANDIDATE_SHA')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- bypass OFF
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance_bypass(jsonb_build_object('user_id', null, 'reason', 'Operator smoke finished')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
-- maintenance OFF (also removes any bypass)
pnpm exec supabase db query --db-url "$DB_URL" "select public.set_maintenance(jsonb_build_object('enabled', false, 'reason', 'Candidate healthy; reopening', 'release_ref', '$RELEASE_REF')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '$OWNER_ID')::text, true)) s"
```

### Verification SQL (read-only; run as often as needed)

```
-- V1: migration version
select count(*) as applied, max(version) as latest from supabase_migrations.schema_migrations;
-- V2: maintenance state
select enabled, enabled_at, release_ref, bypass_user_id, bypass_expires_at, bypass_expires_at > clock_timestamp() as bypass_live from private.system_maintenance;
-- V3: every API-executable write function calls the guard as its FIRST statement (must return 0 rows). Same rule as the
-- reviewed pgTAP convention (supabase/tests/maintenance.test.sql): comments stripped; the language must be PL/pgSQL; the
-- DECLARE section may not hold an initializer (:=, =, DEFAULT run before BEGIN); a NULL, unparseable or non-PL/pgSQL
-- body is listed (fails closed), never skipped. The post-36 gate (P09) runs this exact query.
select p.oid::regprocedure::text as unguarded from pg_proc p left join pg_language l on l.oid = p.prolang
  cross join lateral (select regexp_replace(regexp_replace(coalesce(p.prosrc, ''), '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as src) s
  cross join lateral (select substring(s.src from '(?i)^(.*?)\mbegin\M') as declared, substring(s.src from '(?i)\mbegin\M(.*)$') as body) b
  where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
    and not coalesce(l.lanname = 'plpgsql' and b.declared is not null and b.body is not null and b.declared !~* ':=|\mdefault\M|='
      and b.body ~* '^\s*perform\s+private\.assert_not_in_maintenance\(\)\s*;', false);
-- V4: the Storage guard trigger exists and is enabled (must be 1)
select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'expense_receipts_maintenance_guard' and tgenabled = 'O' and not tgisinternal;
-- V5: maintenance audit trail
select created_at, action, actor_id, reason, metadata from public.audit_events where entity_type = 'system_maintenance' order by (metadata ->> 'at')::timestamptz;
```

**V6/V7 — quiescence and session inventory** (one read-only script; run it, keep the output):

```
pnpm exec supabase db query --db-url "$DB_URL" -f scripts/ops-01b-quiescence.sql --output-format json > "$EVIDENCE/quiescence-N.json"
```

`quiescent: true` requires: no other client session running a statement or holding a transaction open (`busy` 0), no session that has written in an open transaction (`open_writers` 0, `backend_xid`), no lock waiter (`lock_waiters` 0), and no other session holding a row-write lock on a `public`, `private`, `storage` or `auth` relation (`write_locks` empty). `sessions` lists every other client session (user, application, state, transaction start, whether it wrote, wait, query head): review it for anything that is not the app, Storage, PostgREST, Realtime or the operator.

### Window snapshots and the categorized comparison

`scripts/window-snapshot.sql` prints one JSON line, **record by record**: every row of every public table (whatever migrations add) keyed by its primary key with its full content (the audit trail included), every receipt object (owner, size, type, eTag), the accounts as one hash, the applied migrations, and the full maintenance state.

```
pnpm exec supabase db query --db-url "$DB_URL" -f scripts/window-snapshot.sql --output-format json > "$EVIDENCE/snapshot-NAME.json"
node scripts/window-compare.mjs "$EVIDENCE/snapshot-baseline.json" "$EVIDENCE/snapshot-NOW.json" \
  [--declare scripts/ops-01b-smoke-declaration.json --set NAME=value ...] [--expect-migrations v1,v2] \
  [--expect-maintenance-audit a,b] --expect-maintenance on|bypass|off
```

Never compare two backup fingerprints for plain equality across the release: the migrations legitimately change report shapes and add tables. The comparison sorts every difference into four categories and exits 1 only when something is **unexpected**. **No table is ever "allowed to change"; only declared records are.**

| Category | Contains | Tolerated when |
|---|---|---|
| `release_control` | inserted `maintenance.*` audit rows and the maintenance state | the rows are append-only and in the `--expect-maintenance-audit` order, the final state **follows from them** (on → bypass → revoked → off), and equals `--expect-maintenance` |
| `migration_metadata` | applied migration versions; tables created by a migration | always (and `--expect-migrations` pins the exact set); rows in a new table still need a declaration |
| `operator_smoke` | each inserted/changed/deleted record that matched **exactly one** declared record | only those records |
| `unexpected` | anything else: any other record of any table — including another invoice in the invoice table, an unrelated payment or expense, a business audit row nobody declared, a deletion; a declared record that is missing, ambiguous or has the wrong amount, shop, business date or relationship; a receipt or account that moved; rewritten history; a maintenance state that does not follow from its audit trail | never — this fails the release step |

**The smoke declaration** (`scripts/ops-01b-smoke-declaration.json`) lists the W11 smoke record by record: S1 (invoice number, shop, business date, total, created by the owner) and its batch and registry row; S2 likewise; the payment on S1 (amount, shop, date); the void of S2 and its correction (−S2 total, linked by id); and exactly four business audit rows (`batch.submit` for each batch, `record_payment` for the payment, `invoice.void` for S2). Relationships are checked by reference (`@S1.id`, `@VOID_CORRECTION.id`; `@>S1_BATCH.id` is a forward reference checked once every record matched). **Every material field is pinned** (the comparator's `MATERIAL` contract): invoices also by type (`advance`), quantity (1), customer (none), delivery (not delivered) and note (none); the payment by method (`cash`) and by being outside any batch; the batches as not backdated; the void and its correction by reason, approver and target; each audit row by entity type, reason and the material metadata (amounts, references). A declaration that omits a material field, or a record with a column the contract does not classify, is `unexpected`. If the smoke differs (another type, a customer, a bank payment), change the values in a copy, never drop the field. Fill it from the release log:

```
--set SHOP_ID=<shop id> --set BUSINESS_DATE=<YYYY-MM-DD> --set OWNER_ID=$OWNER_ID \
--set S1_NUMBER=<S1 invoice no.> --set S1_TOTAL=<fils> --set S2_NUMBER=<S2 invoice no.> --set S2_TOTAL=<fils> --set PAYMENT_AMOUNT=<fils> --set VOID_REASON="<the exact void reason typed>"
```

An unfilled placeholder is an error. If S2 is not voided, delete the `VOID`, `VOID_CORRECTION` and `invoice.void` records from a copy of the file first.

### Firewall commands

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
vercel firewall status --json --scope muzzammels-projects                                  # the rule's position in execution order
# operator IP changed: rules update with all three conditions again, then publish
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

### Refusal probe (database)

Proves ordinary writes are refused **without risking a write**: sign in as the owner (who has no bypass yet) and call a write RPC with an **empty command**. The guard answers before any validation, so the call can never write: while maintenance is on it returns `MAINTENANCE_ACTIVE`; if maintenance were somehow off, the same call returns `INVALID_REQUEST` and still writes nothing.

```
TOKEN=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $PUBLISHABLE_KEY" -H "Content-Type: application/json" -d '{"email":"<owner email>","password":"<owner password>"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")
curl -s "$SUPABASE_URL/rest/v1/rpc/create_customer" -H "apikey: $PUBLISHABLE_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"command":{}}'
# expected: {"code":"P0001",...,"message":"MAINTENANCE_ACTIVE"}
```

Do **not** probe with a valid command, and do **not** make an ordinary successful sale after the recovery point (W6): refusals are the proof. A genuine success needed for verification must happen *before* W6 and be included in the recovery point.

## 7. The bootstrap: how the lock starts from migration 35

Production ends at migration 35, which has **no** database maintenance mechanism. Migration 36 installs it. So there is necessarily a short interval in which the Vercel Firewall is up but the database guard is not yet enforcing, and direct authenticated Data API / Storage writes can still be accepted:

```
firewall ON ──► [ 35: no guard ] ──► 36 commits (guard installed, maintenance OFF) ──► set_maintenance(true) commits ──► locked
                 ◄────────────────────── bootstrap interval (seconds) ──────────────────────►
```

There is no reviewed control that closes direct Supabase ingress *before* 36 exists and survives 36 (a pre-36 grant revoke would be undone by 36's own grants, and would be a second, unrehearsed mechanism). The interval is made **safe by definition rather than by prevention**:

1. **Nothing is a recovery point until after the lock.** The authoritative backup and baseline are taken at W6, after the lock, drain and quiescence. A write accepted during the bootstrap interval is an ordinary transaction that completes *before* the recovery point, so the recovery point contains it. Nothing accepted is lost, and nothing accepted comes after the recovery point.
2. **36 is invisible to the old app and to direct clients.** The bodies of the 23 write RPCs move unchanged behind guard wrappers with the same names, signatures and grants; while maintenance is off the wrapper only takes a share lock and returns. A write that crosses the install behaves exactly as it did on 35 (rehearsed: bootstrap writers kept running through the install with zero errors).
3. **The enable is a barrier.** `set_maintenance(true)` takes the exclusive lock, so it waits for every guarded write already admitted (and every Storage insert past its trigger) and returns only after they committed. Every write that starts later refuses with `MAINTENANCE_ACTIVE`.
4. **Run 36 and the enable back-to-back** in the same shell so the interval is seconds, not minutes (step W2 → W3).
5. **What the barrier cannot see.** (a) A connection that bypasses the API entirely (the `postgres` role, the `service_role` key, a pooler session held by an operator tool). Users do not have these. (b) **A transaction that began before 36 and is still open**: it runs the old (unguarded) RPC body, never takes the L1 share lock, so `set_maintenance(true)` does not wait for it, and it can commit *after* the enable returned. Both are why W5 exists: the quiescence script shows such a transaction (idle in transaction, `backend_xid` set, row-write locks), and W6 may not start until it has finished — `pnpm backup:db` with `SHOPKHATA_BACKUP_REQUIRE_QUIESCENT=1` refuses to take the recovery point while it is open (rehearsed, §12). Whatever it wrote is then inside the recovery point.
6. **A receipt upload in flight across the install.** `CREATE TRIGGER` needs SHARE ROW EXCLUSIVE on `storage.objects`, which conflicts with the ROW EXCLUSIVE lock an uncommitted upload holds, so migration 36 **waits** for every upload whose object row is already inserted, and that upload commits first, unguarded (the trigger is not retroactive), before 36 commits. An upload that inserts after 36 commits sees the trigger. Uploads arriving while 36 waits queue behind it (a few seconds of Storage stall). Either way the object is committed before the enable, therefore before W6, and is in the recovery point (rehearsed, §12).
7. **If the lock cannot be established**: do **not** continue, and follow the W3 failure matrix below. 36 is inert only while maintenance is **definitely** OFF. An uncertain state is not OFF: the firewall stays ON until the database state is established.

Rehearsed with a live ordinary writer, an upload held mid-commit across the install, and an old RPC transaction left open (§12): every write the writer was told succeeded is in the database, no write it was told was refused is, it saw no other outcome; the held upload committed before 36; the old transaction blocked the recovery point until it finished.

### W3 failure matrix (UNKNOWN is not OFF)

**Invariant: if the maintenance state is unknown or uncertain, the firewall stays ON. No exception.** Traffic reopens only after an authoritative read of the database state.

An **authoritative state read** means all of the following, against the same `$DB_URL`, each on a **new** connection: V2 returns **exactly one row**; two V2 reads taken at least 10 seconds apart return the same `enabled` and `enabled_at`; the row is internally consistent (`enabled true` with `enabled_at`/`release_ref` set, or `enabled false` with them null; no bypass); and V5 (latest `maintenance.*` audit rows) agrees with it (`maintenance.enabled` with this release ref present exactly when `enabled true`). Save both V2 outputs and V5 in `$EVIDENCE`. Anything less is UNKNOWN.

**Executable form (mandatory, never by eye).** Take the read with `pnpm exec supabase db query --db-url "$DB_URL" -f scripts/ops-01b-w3-state.sql --output-format json > "$EVIDENCE/w3-state-N.json"` (N = 1, 2; a new invocation each time, at least 10 s apart; it returns the singleton rows, the last enable/disable audit row, any still-running `set_maintenance` call and whether other sessions are visible). Keep the W3 output and exit code (`> "$EVIDENCE/w3.json"; echo $? > "$EVIDENCE/w3.exit"`). Then `node scripts/ops-01b-w3-state.mjs --release-ref "$RELEASE_REF" --enable-exit "$(cat "$EVIDENCE/w3.exit")" --enable-output "$EVIDENCE/w3.json" --read "$EVIDENCE/w3-state-1.json" --read "$EVIDENCE/w3-state-2.json" | tee "$EVIDENCE/w3-decision.json"`. It prints the case and `firewall`: the firewall may be removed only when it prints `"firewall":"MAY_REMOVE"` (exit 0); every other output or exit code means KEEP_ON. After a deliberate maintenance OFF (bootstrap abort with maintenance ON, W14 → W15) run it the same way with `--transition disable` and the disable's output and exit code.

| Case | What you know | Firewall | Action |
|---|---|---|---|
| **1** | The enable command **definitely failed** (it returned an error from the database, e.g. `MAINTENANCE_STATE_MISSING`, `INSUFFICIENT_ROLE`, a syntax error) **and** an authoritative state read shows `enabled false`. | ON until the abort is complete | `scripts/ops-01b-w3-state.mjs` prints case 1, `MAY_REMOVE`. Either retry W3 (idempotent) and re-classify, or **bootstrap abort** (§10): additionally confirm P10 (restore context empty) and V2 no bypass, then remove the firewall and probe. Production is at 36 with the old app. |
| **2** | The enable command **returned** `changed: true, enabled: true` (or a retry returned `changed: false, enabled: true`) **and** an authoritative state read shows `enabled true`. | ON | Locked. Continue at W4, or, if the release must stop, follow the locked recovery / forward-recovery path (§10). Do not remove the firewall while maintenance is ON. |
| **3** | The enable result is **uncertain**: timeout, dropped connection, client or shell crash, no output, output you cannot parse, or the state cannot be queried. | **ON. Do not reopen.** | Do not assume either outcome. Re-establish database connectivity (new shell, new connection, same `$DB_URL`; check the Supabase status page and project health). Then take an authoritative state read and re-classify as case 1 or 2. Retrying W3 is allowed only once a state read has succeeded (it is idempotent, so it cannot double-audit). |
| **4** | The **state read itself** is uncertain or inconsistent: it errors or times out, returns 0 rows or more than 1, two reads disagree, the row contradicts the audit trail, or the row is internally inconsistent. | **ON. Do not reopen.** | Treat as UNKNOWN. Stop the window. Do not run set_maintenance, do not edit `private.system_maintenance` by hand, do not restore. Collect V1, V2 (raw), V4, V5, `pg_stat_activity` and the failing output into `$EVIDENCE`; escalate to the owner. Proceed only through a reviewed corrective step that ends with an authoritative state read, then re-classify as case 1 or 2. |

The firewall is removed **only** in case 1 (after the abort steps) or at W15 after a definite disable (W14). Cases 3 and 4 never reopen traffic, whatever the elapsed time.

### Migration 36 is a controlled bootstrap gate

**Why P03 hashes `private.assert_maintenance_controller()`.** Both control RPCs (`set_maintenance`, `set_maintenance_bypass`) authorize in two layers, and neither may be weakened because the other exists: (1) *preliminary*: `perform private.assert_maintenance_controller()` (SECURITY DEFINER, `search_path ''`, no API grant) runs first and refuses a caller without `auth.uid()` (28000) or who is not an active owner (`private.is_owner()`, 42501) **before** any lock; (2) `private.maintenance_lock_exclusive()` takes the exclusive L1 row lock (`FOR UPDATE` on `private.system_maintenance`), which blocks every guarded write and upload; (3) *authoritative*: `private.assert_account_admin()` repeats the owner check under the L2 advisory lock, after L1, so it sees every committed role change. Without layer 1 any signed-in user could queue on L1 and stall every write, and anything added to its body runs with definer rights for every caller; so its body, flags, owner and settings are part of P03 (P1C, 2026-11-06), and any drift STOPs at W2b.

**The complete maintenance authorization chain, and which gate protects each link (P1D, 2026-11-06).**

| Step | Function | Created by | Security-relevant content | Protected by |
|---|---|---|---|---|
| entry | `public.set_maintenance(jsonb)`, `public.set_maintenance_bypass(jsonb)` | 36 | first statement `perform private.assert_maintenance_controller()`; then L1; then `actor := private.assert_account_admin()` | P03 |
| pre-lock | `private.assert_maintenance_controller()` | 36 | `auth.uid()` not null (28000), `private.is_owner()` (42501) | P03 |
| owner predicate | `private.is_owner()` | 20260828164246 (rls) | `language sql stable security definer set search_path = ''`: an active `public.profiles` row with `id = auth.uid()` and `role = 'owner'` | **C23** (DB35) and P03 (post-36) |
| lock (L1) | `private.maintenance_lock_exclusive()` | 36 | `FOR UPDATE` on the `private.system_maintenance` singleton | P03 |
| post-lock, authoritative | `private.assert_account_admin()` | 20261004100000 (owner account administration) | `auth.uid()` not null; **L2** `pg_advisory_xact_lock(hashtextextended('account-administration', 0))` (the account-administration lock shared with every admin RPC); then `private.is_owner()` (42501); returns `auth.uid()` as the audited actor | **C23** (DB35) and P03 (post-36) |

`is_owner()` and `assert_account_admin()` exist before migration 36 and migration 36 does not redefine them (it only calls them; the release tests prove their C23 fingerprint is identical at DB35 and DB36). So the DB35 preflight (C23) proves the reviewed definitions before the window opens, and the post-36 gate (P03, 12 functions, both variants) proves the whole chain once 36 is in. **Migration history alone proves nothing about bodies**: a recorded `20261004100000` says the file ran once, not that `assert_account_admin()` still has that body, owner or `search_path`.

Bounded dependency analysis (only functions whose drift can directly change the authorization decision or the authorization lock): `is_owner()` calls `auth.uid()` and reads `public.profiles`; `assert_account_admin()` calls `auth.uid()`, the built-ins `pg_advisory_xact_lock`/`hashtextextended`, and `private.is_owner()`; `assert_maintenance_controller()` calls `auth.uid()` and `private.is_owner()`. There is **no other application-owned helper** in the chain. `auth.uid()` is Supabase Auth's platform function (schema `auth`, managed and upgraded by Supabase, outside the application migrations, like the PostgreSQL built-ins) and is deliberately not fingerprinted: its hosted definition follows the Auth version, not this repository. The persistent state the decision reads is `public.profiles`: its writers are only the fingerprinted SECURITY DEFINER admin RPCs (C05) because no API role holds a write right on it (C08, C18, C19); RLS is on (C09) with the reviewed policy (C10); it has no trigger, and adding one changes C15's count and fingerprint; and the structure of `id`, `role`, `is_active` is fixed by C23 (a `role` default of `'owner'`, a nullable or re-defaulted `is_active`, a retype or a generated column STOPs). `private.maintenance_reason(jsonb)` and `private.maintenance_state(private.system_maintenance)` stay outside P03: they validate the reason text and format the result, both run only after the pre-lock owner check, and neither takes part in the authorization decision or a lock.

The pre-window gate proves the catalog prerequisites of the Storage trigger, not that hosted Postgres will accept the DDL (§4.1, "What C13 proves"). So:

- 36 is applied only with the **firewall ON** (W1) and the **preflight PASS** (§4.1) from the same `$DB_URL`;
- **immediately** afterwards, before the enable or anything else, `scripts/ops-01b-post36-verify.sql` must PASS (W2b): P01 exactly 36 migrations; P02 the trigger exists once on `storage.objects`, enabled, BEFORE INSERT FOR EACH ROW, calling `private.storage_receipt_maintenance_guard()`, with the exact reviewed definition; P03 the guard, restore-context, controller-authorization (`private.assert_maintenance_controller()`), control and pre-36 authorization-chain (`private.is_owner()`, `private.assert_account_admin()`) functions with the reviewed signatures, bodies (canonical hash), security-definer flags, `proconfig`/`search_path` and owner — 12 functions, the same inventory and fingerprint in the restore variant; P04 `owner_id`/`bucket_id`/`name` still `text`; P05 no API role or `PUBLIC` holds any privilege on the maintenance state, the restore context or the private functions; P06 the controls executable by `authenticated` only; P07 no unexpected or disabled trigger on `storage.objects`; P00 the expected-state mode is `w2b` (an absent or unknown mode STOPs); P08 exactly one singleton with `enabled false` and no bypass (enforced, not read by eye); P09 V3 = 0 rows and 23 guarded RPCs; P10 the restore context is empty;
- **if the push fails**: each migration is one transaction, so nothing changed; V1 shows 35 (verify it). STOP the release with the firewall still ON; read the error; remove the firewall only after V1 = 35 is confirmed (§10);
- **if the post-36 gate STOPs**: do **not** go to W3. Keep the firewall ON. Inspect the actual state (the failing check's `got`, V1, V2, V4, `pg_trigger` on `storage.objects`). 36 with maintenance off is transparent to the old app, so the safe states are: recover forward with a reviewed corrective migration, or — only if the defect is understood and harmless with maintenance off (e.g. nothing is installed wrongly, only an extra privilege that a reviewed migration revokes) — reconcile, re-run the gate, then continue. Never edit the trigger or the functions by hand in the window, and never edit the migration history.

## 8. State machine

| State | Firewall | DB maintenance | Bypass | DB | App on canonical |
|---|---|---|---|---|---|
| 0 Normal | off | (not installed) | — | 35 | e4f4cfe |
| 1 Closed app | ON | (not installed) | — | 35 | e4f4cfe |
| 2 Bootstrap | ON | installed, **off** | — | 36 | e4f4cfe |
| 3 Locked | ON | ON | off | 36 | e4f4cfe |
| 4 Quiescent, **recovery point taken** | ON | ON | off | 36 | e4f4cfe |
| 5 Migrating | ON | ON | off | 37 → 38 → 39 | e4f4cfe |
| 6 DB verified | ON | ON | off | 39 | e4f4cfe |
| 7 Operator verification | ON | ON | ON (owner, ≤ 60 min) | 39 | candidate |
| 8 Reopen | off | off | off | 39 | candidate |

## 9. Procedure

### Before the window (nothing here touches traffic)

1. **Inventory gate** (§4.1 and §4.2): all PASS, outputs saved. Any STOP ends the attempt.
2. **Candidate identity** (§4.2 "Candidate"): CI green; staged with `vercel deploy --prod --skip-domain --env SHOPKHATA_RELEASE=$CANDIDATE_SHA` from a clean worktree; `dpl_` id recorded; its `/api/health` shows `$CANDIDATE_SHA`.
3. **Rollback target** recorded: current canonical `dpl_` id and `/api/health` release.
4. **Backup capability**: `pnpm backup:db`, then `pnpm backup:verify --from <folder>` ends `RESTORE VERIFIED` (deployment.md §1–2). This is a *capability check and a safety copy only*. It is **not** the recovery point: writes will continue until W3.
5. `OPERATOR_IP` checked from the smoke network; staff told the system will be unavailable.

### The window

**State 0 → 1: close the app**

- **W1.** Publish the firewall rule (§6). Run the firewall probe from a non-operator network: pages 403, health 200. `vercel firewall status` shows the rule active.

**State 1 → 3: bootstrap (§7)**

- **W2.** `S=$(stage 20261103140000)`; dry-run lists only `20261103140000`; push (same `$DB_URL` as the preflight).
  - *Failure:* the push failed → nothing changed (still 35). Firewall stays ON until V1 = 35 is confirmed; then remove it; normal operation. Stop the release.
- **W2b. Post-36 gate (mandatory, before W3).** `pnpm exec supabase db query --db-url "$DB_URL" -f scripts/ops-01b-post36-verify.sql --output-format json > "$EVIDENCE/post36.json"` → `verdict: PASS` (P01–P10, §7 "controlled bootstrap gate").
  - *STOP:* firewall stays ON; do **not** proceed to W3; follow §7 "Migration 36 is a controlled bootstrap gate".
- **W3.** *Immediately*, maintenance ON (§6). Result `changed: true, enabled: true`.
  - *Failure or uncertain:* firewall stays ON. Classify with the W3 failure matrix (§7): only case 1 (enable definitely failed **and** an authoritative read shows OFF) may lead to the bootstrap abort and firewall removal. Uncertain result or uncertain state (cases 3, 4): firewall ON, re-establish the state first; never reopen.
- **W4.** Prove the app and the backend are closed. V1 = 36; V2 `enabled true`; V3 = 0 rows; V4 = 1; V5 shows `maintenance.enabled` with the release ref. Firewall probe again (non-operator network). Database refusal probe (§6) returns `MAINTENANCE_ACTIVE`. A direct receipt upload by an ordinary account is refused and `select count(*) from storage.objects where bucket_id='expense-receipts'` does not move.

**State 3 → 4: drain, quiescence, recovery point**

- **W5.** Prove quiescence. Every guarded write admitted before W3 has committed (the enable waited for it), but a transaction that began **before 36** did not take the lock (§7 point 5). Now:
  1. Observation 1: `scripts/ops-01b-quiescence.sql` → `quiescent: true` (busy 0, open writers 0, lock waiters 0, no write locks). Save it.
  2. Wait **at least 5 seconds**.
  3. Observation 2: the same → `quiescent: true`. Save it. The two `at` values must be ≥ 5 s apart.
  4. Review `sessions` of observation 2 (V7): only the app/Storage/PostgREST/Realtime pools, all `idle` with no `xact_start`, and the operator; no `postgres`, `service_role` or unknown session in a transaction.
  - *Not quiescent:* find the session (`sessions`: user, application, state, query head, `wrote`), let it finish (an old RPC commits or rolls back on its own; an operator tool is closed), then start W5 again from observation 1. Never cancel a business transaction to make the check pass. Do not take the recovery point while anything is open.
- **W6.** **Authoritative recovery point** — only now:
  1. `SINCE=$(select clock_timestamp())` — write it in the release log.
  2. `SHOPKHATA_BACKUP_REQUIRE_QUIESCENT=1 pnpm backup:db` — it re-runs the quiescence check before and after the dumps and refuses if anything is open, and refuses if the database changed while it was being dumped. Then `pnpm backup:verify --from <folder>` → `RESTORE VERIFIED` (it reports `maintenance state: restored LOCKED`, and restores any receipt through the restore context). Copy the folder off-host (backup-restore.md). Its `manifest.json` lists the exact 36 applied migrations: that list, not the checkout, defines any restore (§10).
  3. Baseline: `window-snapshot.sql` → `snapshot-baseline.json`; the standard fingerprint `pnpm exec supabase db query --db-url "$DB_URL" -f scripts/backup-fingerprint.sql --output-format json`; V1 (= 36), V2.
  4. Stability proof: take `window-snapshot.sql` again → `node scripts/window-compare.mjs baseline again --expect-maintenance on` must say `COMPARE PASS` with all four categories empty. (Nothing may move between the recovery point and now.)

  The recovery point is therefore **DB at migration 36, maintenance ON, no bypass, quiescent**. From here on **no ordinary business transaction may be accepted**; the only permitted writes are the declared operator smoke at W11.

**State 4 → 6: migrate and verify**

- **W7.** `S=$(stage 20261103150000)`; dry-run lists only it; push. V1 = 37; V3 = 0 rows (now includes `void_invoice`); `compare baseline now --expect-migrations 20261103150000 --expect-maintenance on` → PASS.
- **W8.** `S=$(stage 20261103190000)`; dry-run; push. V1 = 38; compare `--expect-migrations 20261103150000,20261103190000 --expect-maintenance on` → PASS.
- **W9.** `S=$(stage 20261103203806)`; dry-run; push. V1 = 39 / `20261103203806`; V2 still `enabled true`, no bypass; V3 = 0; V4 = 1; compare `--expect-migrations` all three `--expect-maintenance on` → PASS. Business data identical to the baseline, record by record.
  - *Failure at any push:* that migration rolled back; V1 shows the previous version; both controls stay ON. Read the error, fix the cause (e.g. a dependent object), re-run the same step (§10).

**State 6 → 7: operator verification**

- **W10.** Re-check `OPERATOR_IP`. Bypass GRANT for `$OWNER_ID`, 60 minutes (§6). V5 shows `maintenance.operator_bypass_enabled` with `expires_at` and `renewal: false`. If the smoke runs late, grant again (a renewal; it is audited as such). Promote the staged candidate (no rebuild): `vercel promote <candidate dpl_> --scope muzzammels-projects --yes`. Poll `https://shopkhata.vercel.app/api/health` until `release` = `$CANDIDATE_SHA` (alias swap takes 0–6 s). `vercel inspect shopkhata.vercel.app` shows the candidate `dpl_` id.
- **W11.** Operator smoke on **canonical** from the operator IP, signed in as the owner. Use these fixed references (write them in the release log):
  - Dashboard loads; Sales report loads (business-date totals); open Daily Close for today (do not close it).
  - Save **invoice S1** (any small total); record a payment on S1; view S1's detail.
  - Save a **separate** invoice **S2** and leave it unpaid. If voiding is part of the agreed smoke, void **S2** (reason ≥ 10 characters). **Do not void S1**: an invoice that has received a payment correctly refuses with `PAYMENTS_OUTSTANDING`.
  - These are the *only* writes after the recovery point: **two batches** (S1 and S2 are saved separately, one `batch.submit` audit row each), two invoices and their two invoice-number registry rows, one payment, one void and its correction, and exactly four business audit rows (`batch.submit` ×2, `record_payment`, `invoice.void`) — 13 records, nothing else. Write S1/S2 numbers, totals and the payment amount in the release log: they fill the declaration (§6).
  - During the smoke, from a non-operator network canonical pages are still 403, and a staff/manager session's direct write is still `MAINTENANCE_ACTIVE`.
  - *Promotion failure:* canonical never shows the candidate → `vercel promote` again; if it still fails, controls stay ON; see §10. *Smoke failure:* controls stay ON, bypass OFF, decide: fix forward (new candidate, repeat W10–W11) or §10 abort. **Never reopen with a failed smoke.**
- **W12.** Compare to the baseline with the smoke declared record by record: `node scripts/window-compare.mjs baseline now --declare scripts/ops-01b-smoke-declaration.json --set …(release log values) --expect-migrations <the three> --expect-maintenance-audit maintenance.operator_bypass_enabled --expect-maintenance bypass`. Must say `COMPARE PASS`; `unexpected` empty; `operator_smoke` exactly 13 lines, one per declared record. Anything else is a STOP — go to §10.

**State 7 → 8: reopen (order matters)**

- **W13.** Smoke PASS recorded. **Bypass OFF** (§6). V2 shows no bypass; V5 shows `maintenance.operator_bypass_disabled` (`cause: revoked`).
- **W14.** **Maintenance OFF** (§6). Result `changed: true, enabled: false`. V2 `enabled false`; V5 shows `maintenance.disabled`.
  - *Failure* (error, timeout or uncertain result): the firewall stays ON. Re-run V2 until it gives a definite answer; re-run W14 (idempotent). Never remove the firewall while V2 is uncertain or `enabled true`.
- **W15.** Final comparison: `compare baseline now --declare … --set … --expect-migrations … --expect-maintenance-audit maintenance.operator_bypass_enabled,maintenance.operator_bypass_disabled,maintenance.disabled --expect-maintenance off` → PASS (the state on → bypass → revoked → off follows from the audit trail).
- **W16.** Gate first: two state reads (`scripts/ops-01b-w3-state.sql`, new connections, ≥ 10 s apart) and `node scripts/ops-01b-w3-state.mjs --transition disable --release-ref "$RELEASE_REF" --enable-exit <W14 exit> --enable-output <W14 output> --read … --read …` must print `"firewall":"MAY_REMOVE"` (§7 W3 failure matrix, executable form); anything else: firewall stays ON. Then remove the firewall rule and publish (§6). Probe from a non-operator network: `/` and `/login` are 200/307, not 403.
- **W17.** First normal requests: staff open the app and save the first real sale (this is an ordinary transaction *after* reopening; it is not part of any comparison). Final: `/api/health` = `$CANDIDATE_SHA`; fingerprint taken; release log closed.

Why this order: the bypass goes first so the first ordinary write after reopening proves the general path, not the bypass. The database opens before the firewall, so at no point is the app reachable while the database still refuses writes from a session it should accept; the reverse would let staff into an app whose every save fails. The firewall is the last control removed because it is the only one that also blocks reads of old-app screens.

## 10. Failure, forward recovery and safe abort

### Failure states

**Invariant for every row: if the maintenance state is unknown or uncertain, the firewall stays ON.** UNKNOWN is not OFF; traffic reopens only after an authoritative state read (§7 W3 failure matrix).

| Failure | State left | Controls | Action |
|---|---|---|---|
| 36 push fails (W2) | 35, old app | firewall only | Confirm V1 = 35 with the firewall still ON; then remove it; normal operation. |
| Post-36 gate STOP (W2b) | 36 (maintenance off), old app | firewall ON | Do not enable maintenance, do not go on. Inspect; recover forward or reconcile (§7 "controlled bootstrap gate"). |
| W5 never quiescent | 36, locked, old app | both ON | Find the session (V7), let it finish; never take W6 early. |
| Enable definitely failed, state authoritatively OFF (W3, case 1) | 36 (inert), old app | firewall ON | Retry (idempotent); else **bootstrap abort** below. |
| Enable result or state uncertain (W3, cases 3/4) | 36, maintenance UNKNOWN | **firewall ON** | Never reopen. Re-establish connectivity and an authoritative state read (§7 W3 failure matrix), then re-classify. |
| Failure after 37 | 37, old app (Dashboard/Sales report broken) | firewall ON, maintenance ON | Nobody can write or reach the app. Fix forward (below) or abort. |
| Failure during 38 or 39 | previous version (transaction rolled back) | both ON | Fix the cause, re-run the same push. |
| Candidate promotion fails | 39, old app | both ON | Retry promote; else abort. |
| Candidate smoke fails | 39, candidate | both ON, bypass OFF | Fix forward or abort. |
| Maintenance disable fails / uncertain | 39, candidate | firewall ON | Re-check V2, retry W14. Never reopen traffic on an uncertain state. |

### Prefer forward recovery

Once 37 has started the old app cannot run correctly, and migrations are forward-only. **Fix forward whenever possible**: keep both controls ON, stage a corrected candidate (and, if needed, a new migration reviewed like the others), re-run the failed step, and finish the window. Restoring a backup is a last resort, not a reflex. Never edit `supabase_migrations.schema_migrations` by hand and never run `supabase migration repair` without first establishing, by comparing the schema to the migration files, exactly which migration did and did not apply; a migration that failed rolled back completely, so the history is already accurate.

### Bootstrap abort (before 37)

Applies only while the database is at 35 or 36, no migration after 36 has been applied, **and the maintenance state is authoritatively known** (§7 W3 failure matrix; never in case 3 or 4): 36 is compatible with the old app, so **do not restore anything**. If maintenance is ON: bypass OFF, maintenance OFF (§6), then two state reads and `scripts/ops-01b-w3-state.mjs --transition disable` printing `MAY_REMOVE`, then remove the firewall and probe (firewall ON until then). Production is at 36 with the old app, and the release can be retried later from W3.

### Abort with restoration (only when genuinely necessary)

The recovery point (W6) is **DB at 36, locked**. Restoring it undoes 37–39 and anything written after W6. Follow every step, in this order; do not skip one because the situation is urgent.

1. **Keep the Vercel firewall ON.** Do not remove it at any point until step 8.
2. **Establish the actual database state.** V1 (which migrations), V2 (maintenance and bypass), the quiescence script (activity), and a fresh `window-snapshot.sql`. Compare it with `snapshot-baseline.json`: `node scripts/window-compare.mjs baseline now --declare … --set … --expect-migrations <what V1 shows>`. The output says, record by record, what changed and in which category. Save it.
3. **Keep the database maintenance guard on, or re-establish it before any normal direct Supabase session can resume.** The production project (where maintenance is ON) stays locked: do not run "maintenance OFF" on it. The recovery backup **carries the maintenance state** (`private.system_maintenance` is in `data.sql`), so a restore target built from it comes up *locked* — but only if the restore clears the migration-created singleton row first (the restore tool does it: backup-restore.md, step 5; without it the load stops on `system_maintenance_pkey`). Whichever project the restored data lives in, V2 must read `enabled true, no bypass` **before** anything points at it, and the §6 refusal probe must answer `MAINTENANCE_ACTIVE`.
4. **Identify every accepted transaction since the recovery point.** The only writes permitted after W6 are the declared operator smoke. List them: the `operator_smoke` lines of step 2, plus
   ```
   select created_at, action, actor_id, entity_type, entity_id from public.audit_events
   where created_at > '<SINCE from W6>' and action not like 'maintenance.%' order by created_at;
   ```
   and the references in the release log. Any business row after `SINCE` that is **not** in the declared smoke means a control failed: STOP, preserve the database as evidence (do not restore over it), and treat it as an incident (incident-response.md).
5. **Reconcile them explicitly.** For each accepted transaction decide and record: *disposable* (an operator smoke sale/payment/void on a test invoice) or *must survive* (anything a customer or staff member entered). Disposable items need no action. Items that must survive are re-entered by hand after the restore from the audit rows (step 4), exactly like backup-restore.md step 10.
6. **Restore only when the selected recovery point is known to contain everything that must survive**: every accepted transaction since W6 is disposable, or each must-survive item has a recorded re-entry plan. The recovery point itself already contains every transaction accepted before the lock (W6 was taken after the drain). Restore into a **new Supabase project**, not over the original, with the tool, which restores **exactly the manifest's migration set** — for the W6 backup, the 36 migrations ending `20261103140000` — even though the candidate checkout holds 37–39:

   ```
   SHOPKHATA_RESTORE_DB_URL=<new project database URL>
   SHOPKHATA_RESTORE_SUPABASE_URL=https://<new ref>.supabase.co
   SHOPKHATA_RESTORE_SERVICE_ROLE_KEY=<new project's service-role key>
   node scripts/backup.mjs restore --from <W6 backup dir> --confirm <new ref>.supabase.co
   ```

   It refuses a target that already has migrations; stages only the manifest's versions (STOP if one is missing or ambiguous in the checkout); requires the push dry run to list exactly those versions in that order; pushes; requires `schema_migrations` to equal the manifest list exactly (STOP otherwise; never repair the history by hand); loads `data.sql` (the maintenance row comes back **locked**); restores the receipts through the receipt restore context and closes it; and requires the fingerprint to equal the manifest's. **Never** use a plain `supabase db push` from the candidate checkout for this: it would apply 37–39.
7. **After the restore, verify the maintenance protection before any traffic can reopen**: V1 = exactly the 36 manifest versions (37–39 absent), `scripts/ops-01b-post36-verify-restore.sql` PASS (the restore mode: P08 accepts `enabled true`, still requires one singleton and no bypass; never use the W2b file here, and never edit the W2b file's mode), V2 = `enabled true`, no bypass, `private.receipt_restore_objects` empty, the §6 refusal probe answers `MAINTENANCE_ACTIVE`, an ordinary receipt upload is refused, and the restored data's fingerprint equals the W6 fingerprint (the tool checked it; keep its `restore-<host>-….json`).
8. **Only then reopen**, in the normal order: `vercel promote <rollback dpl_>` (the old app is correct on 36) while the firewall is still ON; `/api/health` shows the rollback release; maintenance OFF on the restored project (§6, with `$DB_URL` pointing at it); firewall OFF; probe; first normal sale. Repoint the application at the new project only as part of the documented restore (backup-restore.md step 9), after step 7.

## 11. Release log checklist

Copy into the release log and fill in during the window.

```
[ ] Inventory gate Supabase: verdict PASS, file, manual evidence (Edge Functions, GraphQL, hooks):
[ ] Inventory gate Vercel: team/project, domains, aliases, canonical dpl_, health SHA, protection, firewall status, bypass credential?:
[ ] Candidate SHA / staged dpl_ / target / CI run:
[ ] Rollback dpl_ / release:
[ ] OPERATOR_IP (checked at start / before smoke):
[ ] Capability backup folder + RESTORE VERIFIED time (not the recovery point):
[ ] W1 Firewall published (time), probe results:
[ ] Preflight evidence: session current_user/session_user, storage.objects owner, storage schema version, BEFORE INSERT triggers:
[ ] W2 36 applied (time), dry-run listed only 36, same $DB_URL as the preflight:
[ ] W2b post-36 gate PASS (file), P08 enabled=false:
[ ] W3 Maintenance ON (time), audit row id, seconds since W2:
[ ] W4 V1/V2/V3/V4, firewall probe, DB refusal probe (account, RPC, message), upload refusal:
[ ] W5 quiescence observation 1 (at, quiescent) / observation 2 (at >= 5 s later, quiescent) / sessions reviewed:
[ ] W6 SINCE timestamp:
[ ] W6 Recovery backup (REQUIRE_QUIESCENT=1) folder + manifest migrations (36, last 20261103140000) + RESTORE VERIFIED (locked) + off-host copy:
[ ] W6 Baseline snapshot + fingerprint sha256; stability compare PASS:
[ ] W7 37 applied, compare PASS:
[ ] W8 38 applied, compare PASS:
[ ] W9 39 applied, V1-V4, compare PASS:
[ ] W10 Bypass GRANT (time, expires_at, renewal?) / Promoted (time), canonical dpl_, /api/health release:
[ ] W11 Smoke references (shop, business date, S1 no. + total, payment amount, S2 no. + total, void yes/no):
[ ] W11 Non-operator still blocked during smoke (firewall probe, RPC refusal):
[ ] W12 Record-level compare with the declaration: unexpected = 0, operator_smoke = 13 records, --expect-maintenance bypass:
[ ] W13 Bypass OFF (time):
[ ] W14 Maintenance OFF (time), V2:
[ ] W15 Final compare PASS:
[ ] W16 Firewall removed (time), probe:
[ ] W17 First staff sale (time), final /api/health, fingerprint:
```

## 12. Rehearsal record (2026-11-04)

### Corrected window, local stack (`tests/integration/operations/release-window-rehearsal.test.ts`)

Runs the sequence above with the real commands: staged `supabase db push --db-url` (each dry run must list exactly one migration), the §6 control SQL through `supabase db query`, `pnpm backup:db` / `backup:verify`, `scripts/ops-01b-preflight.sql`, `scripts/window-snapshot.sql` and `scripts/window-compare.mjs`. The Vercel Firewall is the one control that cannot run locally; it was rehearsed on a disposable Vercel project (below).

| Step | Result |
|---|---|
Re-run 2026-11-04 after the release/recovery-gate remediation (transcript below).

| Step | Result |
|---|---|
| P0 | Production modeled at migration 35 with business data (customers, a sale, an expense). |
| P1 inventory gate | `ops-01b-preflight.sql` on the 35 state as `postgres`: **PASS** (25 checks). 26 simulated drifts (`tests/integration/operations/preflight-drifts.ts`), each in a rolled-back transaction, each **STOP on its own check**: the 12 earlier ones, plus a disabled Storage trigger, the guard name taken, `owner_id` of another type, the migration role without TRIGGER on `storage.objects` (revoked from `postgres` and the API roles it inherits it through), a write policy on another Storage table, and Q1–Q8: INSERT to PUBLIC, UPDATE to PUBLIC, a writable view granted to PUBLIC, a writable view granted to `authenticated`, an INSTEAD OF trigger mutation surface, an expected trigger disabled, an expected trigger function edited, an unexpected exposed mutation function (in `public` and in `graphql_public`). Storage-owner drifts are applied as `supabase_admin`; the gate then runs as `postgres` again. |
| P2 | Backup capability proven (`backup:db`, `backup:verify` → `RESTORE VERIFIED`); not the recovery point. |
| R (bootstrap receipt) | A staff receipt upload's commit transaction was parked **after** its `storage.objects` INSERT (uncommitted), then 36 was pushed. 36 **waited**: `ShareRowExclusiveLock` (CREATE TRIGGER) blocked by the upload's `RowExclusiveLock`, and did not commit while the upload was open. Released: the upload committed first (no guard existed when it inserted — the trigger is not retroactive), then 36 committed. The object is in the W6 recovery point. With the test's hold trigger still present the post-36 gate STOPs on P07 (it sees a foreign trigger). |
| S (old RPC) | A staff `create_customer` call made **before** 36 inside a transaction left open. 36 installed and maintenance enabled without waiting for it (it never took L1). W5: `quiescent false` (open writers 1, 3 write locks, `idle in transaction`); `SHOPKHATA_BACKUP_REQUIRE_QUIESCENT=1 pnpm backup:db` **refused** ("not quiescent before the dumps"). Drained (committed): its row is in the recovery point. |
| Bootstrap (W2/W3) | Live staff writer throughout: 245 accepted, 48 refused with `MAINTENANCE_ACTIVE`, **0 other outcomes**; every accepted write stored, no refused one. |
| W2b | Post-36 gate **PASS** (10 checks); 11 simulated install defects each STOP on their check: trigger missing, disabled, AFTER instead of BEFORE, guard body edited, extra foreign trigger, state readable by `authenticated`, restore context executable by `authenticated`, a wrapper without the guard, `owner_id` retyped, a leftover restore listing, a later migration already applied. |
| W4 | Staff, manager, owner refused; direct receipt upload refused; V3 (the runbook's own text) 0 rows; V4 = 1. |
| T (W5) | Two observations 5.2 s apart, both quiescent; 0 lock waiters; 12 sessions, all `idle`, no open transaction (`authenticator`, `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`). |
| W6 | Recovery point with `REQUIRE_QUIESCENT=1`: holds the bootstrap receipt and the drained old-RPC write; `RESTORE VERIFIED` (restored **LOCKED**, the receipt through the restore context); baseline stable (`--expect-maintenance on`, all categories empty). |
| W7–W9 | 37, 38, 39 single-migration pushes; after each, every record identical to the baseline; maintenance ON; V3 = 0. |
| W10–W11 | Bypass; staff/manager refused; S1 + payment, S2 + void (two batches); S1 void refused `PAYMENTS_OUTSTANDING`. |
| W12 | Record-level comparison with `scripts/ops-01b-smoke-declaration.json`: 13 declared records matched, `unexpected` 0, `--expect-maintenance bypass`. |
| W15 | After revoke + disable: PASS with state on → bypass → revoked → off. Without the declaration: FAIL. With `--expect-maintenance on`: FAIL. |
| A1 | Accepted since the recovery point: `batch.submit ×2, invoice.void, record_payment` — exactly the declared audit rows. |
| W16–W17 | Reopened; staff writes normally. |

Comparator negatives (`tests/unit/window-compare.test.ts`, synthetic snapshots around the real declaration template), each must FAIL: unrelated invoice rewrite in a declared table, unrelated payment, unrelated expense, unexpected business audit event, unexpected deletion, extra smoke-like row, wrong amount on a smoke record, wrong shop, wrong business date, wrong final maintenance state; also an ambiguous duplicate, a missing declared record, a broken relationship, a rewritten maintenance audit row, an unexpected receipt, an account change, and a final state that does not follow from the audit trail.

**Locked, populated, exact-version restore** (`tests/integration/operations/locked-restore.test.ts`): source at migration 36 with an expense, its registered PNG receipt (real bytes) and maintenance ON; a plain service-key upload is refused there (the M1 defect, shown). Backup (`REQUIRE_QUIESCENT=1`): manifest 36 migrations, 1 receipt. (a) `backup:verify` → `RESTORE VERIFIED`, restored LOCKED, receipt through the context. (b) A **blank** project (no migrations table), checkout holding 37–39, `node scripts/backup.mjs restore` as `postgres` by URL: `schema_migrations` = exactly the manifest's 36 versions, 37/38/39 absent (`invoice_voids`, `void_invoice` absent), post-36 gate PASS, maintenance `enabled`, no bypass; receipt bytes identical, `storage.objects` owner/owner_id/created_at/size/type/eTag identical to the source, attachment → expense → shop identical, no orphan either way; restore context empty, log `opened:1,closed:1`; afterwards staff RPC and upload refused, service-key upload of a new name refused, service-key re-upload of the restored name refused (context closed); a second restore into the now non-empty target refused. This run found that `postgres` cannot COPY even an empty section into `storage.buckets_vectors`; the tool now skips empty sections (backup-restore.md step 5).

### Concurrency (`tests/integration/operations/maintenance.test.ts`, real Data API, real Storage API, separate sessions)

Storage uploads are held at the two decisive points with a test-only trigger pair that waits on an advisory lock the test owns: before the maintenance trigger (admitted by the permission test, not yet at the guard) and after it (past the guard, share lock held, uncommitted).

| Race | Result |
|---|---|
| Upload admitted before activation | Activation returns at once (the upload holds no lock yet); when the upload then reaches the guard it is **refused**, no `storage.objects` row, and the already-sent bytes are deleted by Storage; a later ordinary upload is refused. |
| Upload past the guard, then activation | Activation **waits** (still `enabled = false` after 1.2 s); when the upload commits, the activation reports success and the object row is already committed; a later ordinary upload is refused. |
| Bypass upload admitted before revocation | Revocation returns at once; the upload is **refused** at the guard; no object. After revocation a bypass upload is refused. |
| Bypass upload past the guard, then revocation | Revocation **waits**; reports success only after the upload committed; after it, a bypass upload is refused. |
| Business write under the bypass vs revocation | Revocation waits for the write; after it, the same write refuses. |
| Admin RPC (holds L1, then takes L2) vs control RPC | Both complete, no deadlock; the control transition waited for the admin write. |
| Positive control: the reverse order (L2 then L1) | Deadlocks (`deadlock detected`), so the test above would catch a regression. |
| Bypass grant vs disable | One consistent state (`enabled = false`, no bypass), the auto-clear audited `maintenance_disabled`; a grant after the disable is refused. |
| Existing: write in flight vs enable; write after an uncommitted enable; two owners enabling/disabling concurrently | Unchanged and passing. |

Mutation proof: with the trigger taking a plain read instead of the share lock, the two "waits" cases fail; with no trigger (policy only, the previous design) all four Storage cases fail. The restored migration passes all of them.

### Firewall (disposable Vercel project, deleted afterwards)

The §6 rule shape (host, `path neq /api/health`, `ip_address neq <IP>`, deny) was published on a throw-away project and alias:

- With the exception set to another IP, from this machine: `/` 403, `/api/dashboard` 403, `POST /api/dashboard` 403, `/api/healthz` 403, `/api/health/../dashboard` 403, `/api/health%2F..%2Fdashboard` 403; `/api/health`, `/api/health/`, `/api/health?x=1` and `/api/%68ealth` 200; `/API/HEALTH` 404 (passes the rule, matches no route); `//api/health` 308; the deployment host 302 to Vercel Authentication.
- With the exception set to this machine's IP: `/`, `/api/dashboard`, `POST /api/dashboard` and `/api/health` all 200.
- Live about 1 s after publish, holds across promote and rollback, alias swap 0–6 s.

**Already-open tabs** (`tests/e2e/maintenance.spec.ts`, candidate app): a sale, a payment, an expense and a Daily Close, each filled in and reviewed before maintenance started, are refused by the database when submitted afterwards without a reload; nothing is written; the sale draft stays on the device and saves from the same tab after reopen. Old-app tabs (e4f4cfe) reach the database only through Server Actions, which the firewall blocks, plus the direct receipt upload, which the Storage trigger blocks.

**Not rehearsed here:** the production database and the production Vercel project (out of scope by design: the inventory gate in §4 is the production check, to be run in the pre-window); the Supabase CLI's handling of a production URL is the same command already used for every production migration. The hosted Storage service version is not the local one; the trigger does not depend on Storage internals beyond "the object row is inserted by SQL with `owner_id`". C13a–c prove the catalog prerequisites read-only; installability itself is proven only by W2 + the W2b post-36 gate (§4.1 "What C13 proves"). **PRODUCTION PREFLIGHT NOT YET EXECUTED — REQUIRED BEFORE THE RELEASE WINDOW.**
