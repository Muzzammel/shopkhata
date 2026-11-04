# OPS-01B slice 1 — maintenance release runbook

The production release of OPS-01B slice 1 (maintenance guard, invoice void, historical-sales remediation, sales-RPC release compatibility) behind a two-layer maintenance boundary. Read it end to end before starting. Every step names the command, what it must print, and what to do if it does not.

This runbook is the reviewed procedure. **Do not improvise in the window.** If a check fails, take the failure branch written next to it. Anything not covered is a STOP.

## 1. What the release contains

| # | Migration | Effect |
|---|---|---|
| 35 | `20261031165915_ops_01a_shop_user_status_controls.sql` | **Production today** (35 migrations). Not part of this release. |
| 36 | `20261103140000_ops_01b_maintenance_guard.sql` | Maintenance state, write guard on every business RPC, Storage receipt guard (trigger), owner control RPCs. No behaviour change while maintenance is off. |
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

One global order. A path that needs several of these takes them in this order and never the reverse:

| Lock | What | Taken by |
|---|---|---|
| **L1** | the single `private.system_maintenance` row | `FOR SHARE`: every business write RPC (first statement) and every `expense-receipts` Storage insert, held until that transaction ends. `FOR UPDATE`: `set_maintenance` and `set_maintenance_bypass` (enable, disable, grant, renew, revoke), as their first lock. |
| **L2** | advisory lock `account-administration` | the admin RPCs and the two control RPCs, after L1 |
| **L3** | everything else (per-shop and idempotency advisory locks, invoice and ledger row locks) | after L1 and L2 |

What it guarantees:

- A control transition **waits** for every write or upload admitted before it, and reports success only after they committed or rolled back. No write commits after a reported activation, and no bypass write commits after a reported revocation.
- A write that starts after the transition commits re-reads the row and refuses; one that starts while a transition is queued waits behind it, then refuses.
- L1 is never requested while L2 or L3 is held, so the admin path (L1 then L2) and the control path (L1 then L2) cannot deadlock. The controls reject non-owners **before** queueing for L1 (a cheap unlocked check), so no ordinary user can stall writes by calling them.

### Why Storage is a trigger, not a policy

The browser uploads receipts straight to Storage. The Storage service (inspected in the local stack's `storage-api` 1.80.2) checks the INSERT policy inside a **throw-away transaction it always rolls back**, then uploads the bytes, then commits the real `storage.objects` row in a **second transaction** from a service-role connection that has no RLS. A lock taken inside a policy is released at the first rollback, long before the object commits, so it would serialize nothing: an upload admitted while maintenance was off could commit after maintenance was reported active. A `BEFORE INSERT` trigger fires in **both** transactions, in particular the one that commits the row, so its share lock on L1 is held through that commit. The uploader is identified by `NEW.owner_id` (set by Storage from the verified JWT subject); the connection's own claims are only `{"role":"service_role"}`. The existing INSERT policy is unchanged. A refused upload fails in the permission test before any bytes are sent; one admitted earlier and refused at the final insert leaves no `storage.objects` row, and Storage deletes the bytes it had already written (verified in the rehearsal). Update and delete stay denied to every API role by the existing policies, so insert is the only user-reachable Storage mutation.

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
DB_URL=<production database URL>                 # project ref karvhrylmogxxfegubnc
OWNER_ID=<owner auth user id>                    # select id from public.profiles where role = 'owner' and is_active
OPERATOR_IP=<the operator's public IP>           # curl -s https://api.ipify.org
CANDIDATE_SHA=<full candidate commit>
RELEASE_REF=ops-01b-slice1-$CANDIDATE_SHA
EVIDENCE=<a folder outside the repository>       # every output below is saved here
```

`OPERATOR_IP` must be a network no staff member shares (use a phone hotspot, not the shop Wi-Fi). Check it from the network you will smoke from, and again before the bypass: mobile IPs change. If it changes during the window, edit the firewall rule (§6) before continuing.

Vercel commands run from a folder linked to project `shopkhata` (copy `.vercel/project.json` only) with `--scope muzzammels-projects`. In Git Bash set `MSYS_NO_PATHCONV=1`.

## 4. Pre-maintenance production inventory gate (MANDATORY, before the window)

Everything in this section is **read-only** and happens **before** the release window opens. Save the raw output of every command in `$EVIDENCE`. The expected values are what the OPS-01B migrations were reviewed against; this gate checks the real production against them. **Any STOP means the release does not start** — find out why production differs, and re-review before trying again. There is no "continue anyway".

### 4.1 Supabase (hosted production)

```
# C01-C17: version, migrations, absent OPS-01B objects, RPC signatures/grants/bodies, table write grants, RLS, Storage policies and
# triggers, Realtime, triggers, cron/webhooks, exposed schemas. One JSON document: verdict PASS or STOP.
pnpm exec supabase db query --db-url "$DB_URL" -f scripts/ops-01b-preflight.sql --output-format json > "$EVIDENCE/preflight-supabase.json"
node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[0].preflight;console.log(p.verdict);for(const c of p.checks.filter(c=>!c.ok))console.log('STOP',c.id,JSON.stringify(c.got));console.log(p.manual.join('\n'))" "$EVIDENCE/preflight-supabase.json"
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
| C05 | the 32 function bodies, owners, security-definer flags and `search_path` are byte-identical to the reviewed ones (migration 36 moves them unchanged) | any drift |
| C06 | `anon`, `service_role` and `PUBLIC` execute no public function | any |
| C07 | no volatile function is offered to `anon`/`authenticated` from a schema outside the Supabase-owned ones | any |
| C08 | direct table write grants: only `service_role` INSERT on `backup_records` | any other INSERT/UPDATE/DELETE/TRUNCATE for `anon`, `authenticated`, `service_role` or `PUBLIC` |
| C09 | RLS enabled on every public table | any table without |
| C10 | the 24 public RLS policies are the reviewed ones | any change |
| C11 | the only Storage bucket is private `expense-receipts` with the reviewed limits | another bucket, or a changed limit |
| C12 | `storage.objects` has exactly the four reviewed `expense_receipts_*` policies, unchanged | a differing policy |
| C13 | no trigger on `storage.objects` runs code outside the `storage` schema, **and** the `postgres` migration role may create a trigger there | a foreign trigger, or no TRIGGER privilege (migration 36 could not install the receipt guard) |
| C14 | Realtime publishes no table | any published table |
| C15 | the 46 triggers on public tables are the reviewed ones | an added or changed trigger |
| C16 | no scheduled job and no database webhook | any |
| C17 | exposed API schemas, where stored on the role, are only `public`/`graphql_public` | any other schema |

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
- an unexpected write RPC exists, or a reviewed RPC body/signature/grant differs (C04–C07);
- a direct table mutation grant exists (C08), or RLS is off anywhere (C09), or a policy differs (C10, C12);
- an unexpected Realtime publication, cron job or database webhook exists (C14, C16);
- an Edge Function that mutates business data is deployed;
- the Storage bucket set or any `expense-receipts` policy differs, or the migration role cannot create the Storage trigger (C11–C13);
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
-- V3: every write RPC calls the guard as its first statement (must return 0 rows). Comments are stripped; a function the check
-- cannot parse is listed too, never skipped.
select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
  and coalesce(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') !~* '\mbegin\M\s*perform\s+private\.assert_not_in_maintenance\(\)\s*;', true);
-- V4: the Storage guard trigger exists and is enabled (must be 1)
select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'expense_receipts_maintenance_guard' and tgenabled = 'O' and not tgisinternal;
-- V5: maintenance audit trail
select created_at, action, actor_id, reason, metadata from public.audit_events where entity_type = 'system_maintenance' order by (metadata ->> 'at')::timestamptz;
-- V6: quiescence — no other backend is doing or holding work (must be 0)
select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
  and (state in ('active', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call') or wait_event_type = 'Lock') and query not like '%pg_stat_activity%';
-- V7: who is connected (evidence; look for any session that is not the app, Storage, PostgREST or the operator)
select usename, application_name, state, xact_start, left(query, 60) from pg_stat_activity where datname = current_database() and backend_type = 'client backend' order by xact_start nulls last;
```

### Window snapshots and the categorized comparison

`scripts/window-snapshot.sql` prints one JSON line: for every public table (whatever migrations add) a row count and a hash of every row, the business audit trail, the maintenance audit trail, receipts, accounts, migrations and the maintenance state.

```
pnpm exec supabase db query --db-url "$DB_URL" -f scripts/window-snapshot.sql --output-format json > "$EVIDENCE/snapshot-NAME.raw"
# (save the "snapshot" object of the single row as snapshot-NAME.json)
node scripts/window-compare.mjs "$EVIDENCE/snapshot-baseline.json" "$EVIDENCE/snapshot-NOW.json" [--smoke tables] [--expect-migrations v1,v2] [--expect-maintenance-audit a,b]
```

Never compare two backup fingerprints for plain equality across the release: the migrations legitimately change report shapes and add tables. The comparison sorts every difference into four categories and exits 1 only when something is **unexpected**:

| Category | Contains | Tolerated when |
|---|---|---|
| `release_control` | `maintenance.*` audit rows | always (and `--expect-maintenance-audit` pins the exact set) |
| `migration_metadata` | applied migration versions; tables created by a migration (they must start empty) | always (and `--expect-migrations` pins the exact set) |
| `operator_smoke` | business tables, business audit rows, receipts or accounts the operator **declared** with `--smoke` | only for the declared tables |
| `unexpected` | anything else: any other business row, audit row, receipt or account that moved; rewritten migration history; a dropped table | never — this fails the release step |

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
5. **What the guard cannot see** is a connection that bypasses the API entirely (the `postgres` role, the `service_role` key, a pooler session held by an operator tool). Users do not have these. W5 proves none is active (V6 = 0, V7 reviewed) before the recovery point is taken.
6. **If the lock cannot be established** (the enable fails or stays uncertain): do **not** continue. 36 is inert while maintenance is off and compatible with the old app, so remove the firewall and resume normal operation at 36, or retry the enable (idempotent). Nothing is restored.

Rehearsed with a live ordinary writer (§12): every write it was told succeeded is in the database, no write it was told was refused is, and it saw no other outcome.

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

- **W2.** `S=$(stage 20261103140000)`; dry-run lists only `20261103140000`; push.
  - *Failure:* the push failed → nothing changed (still 35). Remove the firewall; normal operation. Stop the release.
- **W3.** *Immediately*, maintenance ON (§6). Result `changed: true, enabled: true`.
  - *Failure or uncertain:* re-run V2 until it is definite; re-run W3 (idempotent). If it cannot be established, see §10 "Bootstrap abort" (36 is inert and compatible; remove the firewall).
- **W4.** Prove the app and the backend are closed. V1 = 36; V2 `enabled true`; V3 = 0 rows; V4 = 1; V5 shows `maintenance.enabled` with the release ref. Firewall probe again (non-operator network). Database refusal probe (§6) returns `MAINTENANCE_ACTIVE`. A direct receipt upload by an ordinary account is refused and `select count(*) from storage.objects where bucket_id='expense-receipts'` does not move.

**State 3 → 4: drain, quiescence, recovery point**

- **W5.** Prove quiescence. Everything admitted before W3 has committed (the enable waited for it). Now show nothing else is running: V6 = 0 **twice, five seconds apart**; V7 shows only the app/Storage/PostgREST pools, idle, and the operator; no `postgres`, `service_role` or unknown session in a transaction. If anything is busy: find it (V7), let it finish, repeat. Do not take the recovery point while a business transaction is open.
- **W6.** **Authoritative recovery point** — only now:
  1. `SINCE=$(select clock_timestamp())` — write it in the release log.
  2. `pnpm backup:db` (it refuses if the database changed while it was being dumped), then `pnpm backup:verify --from <folder>` → `RESTORE VERIFIED`. Copy the folder off-host (backup-restore.md).
  3. Baseline: `window-snapshot.sql` → `snapshot-baseline.json`; the standard fingerprint `pnpm exec supabase db query --db-url "$DB_URL" -f scripts/backup-fingerprint.sql --output-format json`; V1 (= 36), V2.
  4. Stability proof: take `window-snapshot.sql` again → `node scripts/window-compare.mjs baseline again` must say `COMPARE PASS` with all four categories empty. (Nothing may move between the recovery point and now.)

  The recovery point is therefore **DB at migration 36, maintenance ON, no bypass, quiescent**. From here on **no ordinary business transaction may be accepted**; the only permitted writes are the declared operator smoke at W11.

**State 4 → 6: migrate and verify**

- **W7.** `S=$(stage 20261103150000)`; dry-run lists only it; push. V1 = 37; V3 = 0 rows (now includes `void_invoice`); `compare baseline now --expect-migrations 20261103150000` → PASS.
- **W8.** `S=$(stage 20261103190000)`; dry-run; push. V1 = 38; compare `--expect-migrations 20261103150000,20261103190000` → PASS.
- **W9.** `S=$(stage 20261103203806)`; dry-run; push. V1 = 39 / `20261103203806`; V2 still `enabled true`, no bypass; V3 = 0; V4 = 1; compare `--expect-migrations` all three → PASS. Business data identical to the baseline.
  - *Failure at any push:* that migration rolled back; V1 shows the previous version; both controls stay ON. Read the error, fix the cause (e.g. a dependent object), re-run the same step (§10).

**State 6 → 7: operator verification**

- **W10.** Re-check `OPERATOR_IP`. Bypass GRANT for `$OWNER_ID`, 60 minutes (§6). V5 shows `maintenance.operator_bypass_enabled` with `expires_at` and `renewal: false`. If the smoke runs late, grant again (a renewal; it is audited as such). Promote the staged candidate (no rebuild): `vercel promote <candidate dpl_> --scope muzzammels-projects --yes`. Poll `https://shopkhata.vercel.app/api/health` until `release` = `$CANDIDATE_SHA` (alias swap takes 0–6 s). `vercel inspect shopkhata.vercel.app` shows the candidate `dpl_` id.
- **W11.** Operator smoke on **canonical** from the operator IP, signed in as the owner. Use these fixed references (write them in the release log):
  - Dashboard loads; Sales report loads (business-date totals); open Daily Close for today (do not close it).
  - Save **invoice S1** (any small total); record a payment on S1; view S1's detail.
  - Save a **separate** invoice **S2** and leave it unpaid. If voiding is part of the agreed smoke, void **S2** (reason ≥ 10 characters). **Do not void S1**: an invoice that has received a payment correctly refuses with `PAYMENTS_OUTSTANDING`.
  - These are the *only* writes after the recovery point: one batch, two invoices, one payment, one void (+ its correction), nothing else.
  - During the smoke, from a non-operator network canonical pages are still 403, and a staff/manager session's direct write is still `MAINTENANCE_ACTIVE`.
  - *Promotion failure:* canonical never shows the candidate → `vercel promote` again; if it still fails, controls stay ON; see §10. *Smoke failure:* controls stay ON, bypass OFF, decide: fix forward (new candidate, repeat W10–W11) or §10 abort. **Never reopen with a failed smoke.**
- **W12.** Compare to the baseline with the smoke declared: `node scripts/window-compare.mjs baseline now --smoke batches,corrections,invoice_number_registry,invoice_voids,invoices,payments --expect-migrations <the three> --expect-maintenance-audit maintenance.operator_bypass_enabled`. Must say `COMPARE PASS`; `unexpected` empty; the `operator_smoke` lines match the references in the release log (counts of S1, S2, the payment, the void). Anything else is a STOP — go to §10.

**State 7 → 8: reopen (order matters)**

- **W13.** Smoke PASS recorded. **Bypass OFF** (§6). V2 shows no bypass; V5 shows `maintenance.operator_bypass_disabled` (`cause: revoked`).
- **W14.** **Maintenance OFF** (§6). Result `changed: true, enabled: false`. V2 `enabled false`; V5 shows `maintenance.disabled`.
  - *Failure* (error, timeout or uncertain result): the firewall stays ON. Re-run V2 until it gives a definite answer; re-run W14 (idempotent). Never remove the firewall while V2 is uncertain or `enabled true`.
- **W15.** Final comparison: `compare baseline now --smoke … --expect-migrations … --expect-maintenance-audit maintenance.operator_bypass_enabled,maintenance.operator_bypass_disabled,maintenance.disabled` → PASS.
- **W16.** Remove the firewall rule and publish (§6). Probe from a non-operator network: `/` and `/login` are 200/307, not 403.
- **W17.** First normal requests: staff open the app and save the first real sale (this is an ordinary transaction *after* reopening; it is not part of any comparison). Final: `/api/health` = `$CANDIDATE_SHA`; fingerprint taken; release log closed.

Why this order: the bypass goes first so the first ordinary write after reopening proves the general path, not the bypass. The database opens before the firewall, so at no point is the app reachable while the database still refuses writes from a session it should accept; the reverse would let staff into an app whose every save fails. The firewall is the last control removed because it is the only one that also blocks reads of old-app screens.

## 10. Failure, forward recovery and safe abort

### Failure states

| Failure | State left | Controls | Action |
|---|---|---|---|
| 36 push fails (W2) | 35, old app | firewall only | Remove firewall; normal operation. |
| Enable cannot be established (W3) | 36 (inert), old app | firewall | Retry (idempotent); else **bootstrap abort** below. |
| Failure after 37 | 37, old app (Dashboard/Sales report broken) | firewall ON, maintenance ON | Nobody can write or reach the app. Fix forward (below) or abort. |
| Failure during 38 or 39 | previous version (transaction rolled back) | both ON | Fix the cause, re-run the same push. |
| Candidate promotion fails | 39, old app | both ON | Retry promote; else abort. |
| Candidate smoke fails | 39, candidate | both ON, bypass OFF | Fix forward or abort. |
| Maintenance disable fails / uncertain | 39, candidate | firewall ON | Re-check V2, retry W14. Never reopen traffic on an uncertain state. |

### Prefer forward recovery

Once 37 has started the old app cannot run correctly, and migrations are forward-only. **Fix forward whenever possible**: keep both controls ON, stage a corrected candidate (and, if needed, a new migration reviewed like the others), re-run the failed step, and finish the window. Restoring a backup is a last resort, not a reflex. Never edit `supabase_migrations.schema_migrations` by hand and never run `supabase migration repair` without first establishing, by comparing the schema to the migration files, exactly which migration did and did not apply; a migration that failed rolled back completely, so the history is already accurate.

### Bootstrap abort (before 37)

Applies only while the database is at 35 or 36 and no migration after 36 has been applied: 36 is compatible with the old app, so **do not restore anything**. If maintenance is ON: bypass OFF, maintenance OFF (§6), V2 definite, then remove the firewall and probe. Production is at 36 with the old app, and the release can be retried later from W3.

### Abort with restoration (only when genuinely necessary)

The recovery point (W6) is **DB at 36, locked**. Restoring it undoes 37–39 and anything written after W6. Follow every step, in this order; do not skip one because the situation is urgent.

1. **Keep the Vercel firewall ON.** Do not remove it at any point until step 8.
2. **Establish the actual database state.** V1 (which migrations), V2 (maintenance and bypass), V6/V7 (activity), and a fresh `window-snapshot.sql`. Compare it with `snapshot-baseline.json`: `node scripts/window-compare.mjs baseline now --expect-migrations <what V1 shows>`. The output says what changed and in which category. Save it.
3. **Keep the database maintenance guard on, or re-establish it before any normal direct Supabase session can resume.** The production project (where maintenance is ON) stays locked: do not run "maintenance OFF" on it. The recovery backup **carries the maintenance state** (`private.system_maintenance` is in `data.sql`), so a restore target built from it comes up *locked* — but only if the restore clears the migration-created singleton row first (backup-restore.md, step 6; without it the load stops on `system_maintenance_pkey`). Whichever project the restored data lives in, V2 must read `enabled true, no bypass` **before** anything points at it, and the §6 refusal probe must answer `MAINTENANCE_ACTIVE`.
4. **Identify every accepted transaction since the recovery point.** The only writes permitted after W6 are the declared operator smoke. List them: the `operator_smoke` lines of step 2, plus
   ```
   select created_at, action, actor_id, entity_type, entity_id from public.audit_events
   where created_at > '<SINCE from W6>' and action not like 'maintenance.%' order by created_at;
   ```
   and the references in the release log. Any business row after `SINCE` that is **not** in the declared smoke means a control failed: STOP, preserve the database as evidence (do not restore over it), and treat it as an incident (incident-response.md).
5. **Reconcile them explicitly.** For each accepted transaction decide and record: *disposable* (an operator smoke sale/payment/void on a test invoice) or *must survive* (anything a customer or staff member entered). Disposable items need no action. Items that must survive are re-entered by hand after the restore from the audit rows (step 4), exactly like backup-restore.md step 10.
6. **Restore only when the selected recovery point is known to contain everything that must survive**: every accepted transaction since W6 is disposable, or each must-survive item has a recorded re-entry plan. The recovery point itself already contains every transaction accepted before the lock (W6 was taken after the drain). Restore into a **new Supabase project** (backup-restore.md "Restoring production"), not over the original.
7. **After the restore, verify the maintenance protection before any traffic can reopen**: V1 = 36, V2 = `enabled true`, V3 = 0, V4 = 1, the §6 refusal probe answers `MAINTENANCE_ACTIVE`, and the restored data's fingerprint equals the W6 fingerprint.
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
[ ] W2 36 applied (time), dry-run listed only 36:
[ ] W3 Maintenance ON (time), audit row id, seconds since W2:
[ ] W4 V1/V2/V3/V4, firewall probe, DB refusal probe (account, RPC, message), upload refusal:
[ ] W5 V6 = 0 (time 1) / = 0 (time 2), V7 reviewed:
[ ] W6 SINCE timestamp:
[ ] W6 Recovery backup folder + RESTORE VERIFIED + off-host copy:
[ ] W6 Baseline snapshot + fingerprint sha256; stability compare PASS:
[ ] W7 37 applied, compare PASS:
[ ] W8 38 applied, compare PASS:
[ ] W9 39 applied, V1-V4, compare PASS:
[ ] W10 Bypass GRANT (time, expires_at, renewal?) / Promoted (time), canonical dpl_, /api/health release:
[ ] W11 Smoke references (S1 invoice no., payment, S2 invoice no., void id):
[ ] W11 Non-operator still blocked during smoke (firewall probe, RPC refusal):
[ ] W12 Compare with --smoke: unexpected = 0, operator_smoke lines match the references:
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
| P0 | Production modeled at migration 35 with business data (customers, a sale, an expense). |
| P1 inventory gate | `ops-01b-preflight.sql` on the 35 state: **PASS** (17 checks). Each of 12 simulated drifts, applied inside a rolled-back transaction, flips it to **STOP**: extra write grant, a table published to Realtime, a drifted RPC body, an extra anon-executable function, a volatile function offered from another schema, a custom trigger on `storage.objects`, an extra Storage bucket, a changed Storage policy, RLS off on a table, an unexpected applied migration, the maintenance table already present, a mutation trigger on a business table. |
| P2 | Backup capability proven (`backup:db`, `backup:verify` → `RESTORE VERIFIED`); not the recovery point. |
| Bootstrap (W2/W3) | An ordinary staff writer ran **throughout**. Guard installed (85 writes accepted by then); maintenance ON a few seconds later. Totals for that run: 108 accepted (23 of them between the install and the lock), 57 refused with `MAINTENANCE_ACTIVE`, **0 other outcomes**. Every accepted write is in the database; no refused write is. |
| W4 | Staff, manager and owner (no bypass) refused on write RPCs; a direct receipt upload refused. |
| W5 | 0 busy backends; V3 = 0 rows; V4 = 1. |
| W6 | Recovery point taken **after** quiescence; `RESTORE VERIFIED`; baseline snapshot unchanged one second later. The backup holds the locked `private.system_maintenance` row (§10 step 3). |
| W7–W9 | 37, 38, 39 each applied via a single-migration staged push; after each, business data identical to the baseline (`compare --expect-migrations` PASS), maintenance still ON, V3 = 0. 39 migrations total. |
| W10–W11 | Bypass granted; staff and manager still refused; owner saved S1 and S2, paid S1, **S1 void refused `PAYMENTS_OUTSTANDING`**, S2 voided. |
| W12 | Tables changed: `batches, corrections, invoice_number_registry, invoice_voids, invoices, payments` (exactly the declared smoke). Comparison: `release_control 1, migration_metadata 1, operator_smoke 7, unexpected 0`. The same changes **without** `--smoke` fail. |
| A1 | Accepted since the recovery point (audit): `batch.submit ×2, record_payment, invoice.void`. |
| W13–W14 | Bypass revoked (owner refused again), maintenance disabled; staff writes normally. |

**Restore into a locked database (rehearsed):** loading the W6 `data.sql` into a database built to migration 36 with the documented production restore commands failed on `system_maintenance_pkey` (the singleton row created by migration 36). With `delete from private.system_maintenance;` added to the first restore command (backup-restore.md step 6) it loaded in one transaction and the restored row read `enabled = true`, so the restored database came up locked.

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

**Not rehearsed here:** the production database and the production Vercel project (out of scope by design: the inventory gate in §4 is the production check, to be run in the pre-window); the Supabase CLI's handling of a production URL is the same command already used for every production migration. The hosted Storage service version is not the local one; the trigger does not depend on Storage internals beyond "the object row is inserted by SQL", but C13 must confirm the migration role can create it.
