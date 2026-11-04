# ShopKhata backup and restore runbook

This is written for the person who operates ShopKhata, not only for developers. Keep a printed or offline copy: you need it most when the system is down.

## What a complete backup is

ShopKhata keeps its records in two places, and a backup must hold both:

1. **The PostgreSQL database** — invoices, payments, corrections, replacements, customers, credits, expenses, daily closes, the audit trail, accounts and shop assignments.
2. **The private receipt files** in the Supabase Storage bucket `expense-receipts`. The database only holds each receipt's path and size; the picture or PDF itself lives in Storage.

**A database dump alone is not a ShopKhata backup.** `pnpm backup:db` refuses to run against a hosted project unless it can also download the receipt files.

## What `pnpm backup:db` produces

One folder per backup, named `shopkhata-<environment>-<UTC time>`, by default under `~/shopkhata-backups` (on Windows `C:\Users\<you>\shopkhata-backups`). It is never written inside the source repository.

| File | Content |
| --- | --- |
| `data.sql` | Every row of every application, sign-in (`auth`) and storage-metadata table, produced by `supabase db dump --data-only` (PostgreSQL `pg_dump`) |
| `schema.sql` | The application schema, for reference and worst-case recovery |
| `roles.sql` | Custom database roles (normally none) |
| `storage/expense-receipts/…` | Every receipt file, under its original path |
| `manifest.json` | When it was taken, from which environment and host, the application version and git commit, the list of applied migrations, a SHA-256 of every file, and a fingerprint of the data: row count and hash of every table plus the financial totals of each shop |

The backup fails loudly (non-zero exit, `FAILED:` line) if a dump fails, a receipt cannot be downloaded, a receipt record has no file, or the database changed while it was being dumped. A failed run may leave an incomplete folder behind; delete it.

The folder contains password hashes and all financial data. Treat it like the database itself.

## Taking a backup of production

Run from a checkout of the deployed release, on a trusted computer with Docker running.

```
SHOPKHATA_BACKUP_ENV=production
SHOPKHATA_BACKUP_DB_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
SHOPKHATA_BACKUP_SUPABASE_URL=https://<ref>.supabase.co
SHOPKHATA_BACKUP_SERVICE_ROLE_KEY=<service-role / secret key>
pnpm backup:db
```

- Set the variables in the shell for that session only (PowerShell: `$env:NAME = "value"`). Do not put them in `.env.local`, in a script, or in the repository. See [environment.md](environment.md).
- The database password must be percent-encoded in the URL. Use the **session** connection string (port 5432), not the transaction pooler.
- Take backups when nobody is entering data. If someone saves an entry mid-backup the tool stops and asks you to run it again.
- Optional: `SHOPKHATA_BACKUP_DIR` chooses another destination folder (it must be outside the repository).

Without `SHOPKHATA_BACKUP_DB_URL` the command backs up the local development stack.

## Automatic backups: what to expect and what not to

- Supabase takes its own daily database backups on paid plans (and point-in-time recovery if you buy it). **Turn this on and treat it as the first line of defence.** The free plan has no automatic backups.
- Supabase's database backups **do not include Storage files**. A receipt deleted from the bucket is not recoverable from them.
- Those backups live inside the same Supabase account as the database. If the account is locked, deleted, compromised or the project is removed, they go with it. **A backup whose only copy is in the same hosting account is not safe.**

So ShopKhata needs both: the provider's automatic backups for quick recovery, and `pnpm backup:db` for an independent copy you hold.

## Where to keep backups (off-host)

After every `pnpm backup:db`, copy the whole folder to **at least one place outside the Supabase account and outside the hosting account**, for example:

- an encrypted external drive kept away from the shop computer, and
- a cloud drive in a different account from Supabase/hosting (the owner's own Google Drive, OneDrive or an S3 bucket), in an encrypted archive.

The copy on the computer that ran the backup does not count as off-host.

## Retention recommendation

| Keep | How many |
| --- | --- |
| Daily backups | the last 14 |
| Weekly (end of week) | the last 8 |
| Monthly (after the month's last daily close) | the last 12 |
| Before every deployment or migration | until the next release is confirmed good |

Take a backup at least once every trading day, after the daily close. Delete older folders by hand; nothing is deleted automatically.

## Recovery point and recovery process expectations

The practical recovery point is the newest **complete, successfully copied off-host** backup, not the time an operator started the command. With one verified backup per trading day, activity since that copy may need to be reconciled from source documents; the possible gap can approach a trading day if the backup is delayed or fails. Provider database snapshots do not include receipts, so they are not a complete ShopKhata recovery point by themselves.

Expected recovery requires an operator, the backup folder and its receipt bytes, the compatible release/migration files, a new Supabase project with database/storage/Auth configured, Docker/PostgreSQL tooling, operator credentials, and enough time to restore and reconcile. Duration depends on data/receipt volume, network throughput and provider availability. No recovery-time or recovery-point guarantee is made. Run a monthly isolated drill to measure the actual workflow and update the owner's expectations.

## Proving a backup can be restored

A backup that has never been restored is a hope, not a backup.

```
pnpm backup:verify                      # local stack: back up, wipe, restore, compare
pnpm backup:verify --from <backup dir>  # rehearse a production backup on this computer
```

This **wipes the local development database** and rebuilds it from the backup. It only ever writes to the local Supabase stack. It then checks, and fails unless all of these hold:

1. every backup file still matches its recorded SHA-256;
2. the backup's migration state exists in this checkout;
3. the data restores in one transaction into a database built from the migrations;
4. every receipt file uploads and reads back byte-identical, and every receipt record has its file at the recorded size;
5. every table has the same row count and row hash as when the backup was taken;
6. each shop's sales, payment, expense and customer-due totals, invoice balances, customer balances, customer ledger and closed dates are identical;
7. every active non-owner account, under row-level security, sees only its own shops' invoices and receipt objects;
8. a restored owner can sign in and read the same figures through the application's API.

It writes the evidence to `restore-verification.json` in the backup folder. Run `pnpm backup:verify --from …` on a production backup **at least monthly and before every release**. After rehearsing a production backup the local database holds production data: run `pnpm exec supabase db reset --local` when done.

## Listing a backup in the application (Admin → Backup & Recovery)

The owner can see what has been backed up under **Accounts → Backup & Recovery**: the latest backup and its age, the history, whether each backup's files matched their recorded SHA-256, and the result of its last restore rehearsal. The screen is read-only. It cannot create, download or restore a backup, because each of those would need the database password and the service-role key inside the web application.

A backup appears there only after the operator records it:

```
pnpm backup:record --from <backup dir>
```

- It first re-checks every dump and receipt file against the hashes in `manifest.json` and refuses a folder that does not match.
- It then writes one summary row (time, environment, size, receipt count, manifest SHA-256, rehearsal result) to `public.backup_records`. Nothing else is written, and the backup itself never leaves the operator's computer.
- For a hosted project set `SHOPKHATA_BACKUP_ENV`, `SHOPKHATA_BACKUP_SUPABASE_URL` and `SHOPKHATA_BACKUP_SERVICE_ROLE_KEY` exactly as for the backup. The command refuses to record a backup into a different environment from the one it was taken from.
- Recording the same backup twice changes nothing. Record it again after `pnpm backup:verify --from …` to show the rehearsal result.
- `pnpm backup:db` itself stays read-only against its source; recording is this separate, deliberate step.

`backup_records` is append-only and readable by owner accounts only. No application account can write to it. A backup recorded just before another backup is taken is included in that later backup like any other row.

The screen shows a warning when the newest recorded backup is more than 36 hours old or when none is recorded.

## Restoring production

Do this only when the production data is lost or damaged beyond repair. Stop, breathe, and follow the order.

1. **Stop new entries.** Tell staff to stop. Take the application offline or leave it; do not let anyone keep writing to a damaged database.
2. **Pick the backup.** The newest one from before the damage. Rehearse it first: `pnpm backup:verify --from <backup dir>` must end with `RESTORE VERIFIED`.
3. **Decide the target.** Prefer a **new Supabase project** (same region, PostgreSQL 17). Restoring over the damaged project destroys the evidence and cannot be undone.
4. **Check out a release that contains the backup's migrations**: preferably `git checkout <manifest.app.gitCommit>`, then `pnpm install --frozen-lockfile`. A later checkout also works: the restore applies only the backup's own migrations (step 5).
5. **Restore schema, data and receipts with one command** (Docker running):

   ```
   SHOPKHATA_RESTORE_DB_URL=<new database URL>
   SHOPKHATA_RESTORE_SUPABASE_URL=https://<new ref>.supabase.co
   SHOPKHATA_RESTORE_SERVICE_ROLE_KEY=<new project's service-role key>
   node scripts/backup.mjs restore --from <backup dir> --confirm <new ref>.supabase.co
   ```

   In order, and stopping at the first problem:
   - **Exact migration set.** It refuses a target that already has migrations. It stages **exactly** the versions listed in `manifest.json` (`migrations`), in order, from the checkout — never a later migration the checkout also holds — requires the push dry run to list exactly those versions, pushes, and requires the target's `supabase_migrations.schema_migrations` to equal the manifest list exactly. A plain `supabase db push` would apply every migration in the checkout and is **not** a restore to the backup's version. Never repair the migration history by hand.
   - **Data.** It clears the rows the migrations create (the empty receipt bucket and, from migration 36, the `private.system_maintenance` singleton), then loads `data.sql` in **one transaction** (it either completes or changes nothing) through the `public.ecr.aws/supabase/postgres:17.6.1.159` psql client, then runs `analyze` (without it the invoice screens time out until the database gathers statistics). Empty table sections of `data.sql` are skipped: the `postgres` role of a Supabase project may not write some of Supabase's own tables (`storage.buckets_vectors`, …), which refuse even an empty load; a section *with* rows for such a table still fails loudly (found by the production-equivalent rehearsal, 2026-11-04).
   - **Maintenance state.** Backups taken at migration 36 or later hold it: a backup taken inside a release window restores **LOCKED** (`enabled = true`), which is intended. The tool reports it and never unlocks it. Do not turn maintenance off until the release runbook says so.
   - **Receipts.** Each file is uploaded under its original path and read back byte-identical, and its stored metadata (owner, size, type, eTag) must be unchanged. A locked database refuses uploads without an uploader, so the tool opens the database's **receipt restore context** for exactly the backup's object names (owner-only, logged in `private.receipt_restore_log`, at most 60 minutes) and closes it in every case; any other upload — an ordinary user's, or a service-key upload of another name — stays refused.
   - **Verification.** No receipt record without its file, the fingerprint equal to the manifest's, the migration set still exact. Evidence: `restore-<host>-<time>.json` in the backup folder.

   (`node scripts/backup.mjs restore-receipts --from <backup dir> --confirm <host>`, with the same three variables, re-runs only the receipt step.)
6. *(merged into step 5)*
7. *(merged into step 5)*
8. **Validate before anyone uses it** (next section).
9. **Point the application at the new project**: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the hosting settings and redeploy. Set the Auth site URL in the new project. Everyone must sign in again.
10. **Re-enter what was lost.** Anything saved after the backup was taken is gone. Use paper records and the owner's backdated-entry workflow (with a reason) to re-enter it. Drafts still sitting on a device were never saved and will be sent when the device reconnects.
11. Take a fresh backup of the restored system and store it off-host.

Step 5 has been rehearsed end to end against a blank local Supabase project reached by URL as `postgres` (the hosted role), with a populated, locked backup at migration 36 while the checkout held migrations through 39 (`tests/integration/operations/locked-restore.test.ts`), but not against a hosted project. Rehearse it once against a scratch Supabase project before go-live (see the production checklist).

## Validating a recovery

Run the fingerprint query against the restored database and compare it with `manifest.json`:

```
pnpm exec supabase db query --db-url "<new database URL>" -f scripts/backup-fingerprint.sql --output-format json
```

`tables`, `shops`, `auth_users` and `receipt_objects` must be identical to the `fingerprint` in the manifest. Then, in the application:

- the owner signs in; both shops are listed;
- for each shop the Reports → Customer due total equals `shops.<id>.customer_due_totals.outstanding_due_dirham ÷ 100` in the manifest;
- open one customer ledger and one invoice with a correction; the balances are as expected;
- open one expense receipt; it displays;
- a staff account of Shop 1 cannot see Shop 2.

If any figure differs, the restore has failed. Do not let staff resume; restore again or use an earlier backup.

## How receipts stay consistent with the database

- A receipt is uploaded to `expense-receipts/<shop id>/<expense id>/<random id>.<ext>` and then registered in `public.attachments` with the same path and its size. Files cannot be changed or deleted by any application account.
- The backup records every file's path, size and SHA-256, and fails if a registered receipt has no file.
- On restore, `data.sql` brings back both `public.attachments` and Storage's own index (`storage.objects`); the restore (step 5) then puts the bytes back under the same paths, through the receipt restore context when the database is locked. The rehearsal proves each record has its file at the recorded size.
- Access is decided by the path's shop ID and the account's shop assignment, both of which are restored with the data, so a restored Shop 1 account still cannot open a Shop 2 receipt. The rehearsal tests this.

To recover a single lost receipt file, copy it from the newest backup's `storage/expense-receipts/…` folder and upload it to the same path in the Supabase dashboard (Storage → `expense-receipts`).

## After accidental deletion or corruption

Financial tables are append-only: no application account, including the owner, can update or delete an invoice, payment, correction, expense, close event or audit row. A wrong entry is fixed with a correction or replacement inside the application, not with a restore.

Real damage therefore means someone acted with database-owner access (the dashboard SQL editor, a database password, the service-role key) or the provider had a failure.

1. Stop entries. Write down what was noticed and when.
2. Do **not** try to repair rows by hand in the SQL editor.
3. Take a backup of the damaged state now (it is evidence, and may hold entries newer than the last good backup). Label the folder.
4. Restore the last good backup locally with `pnpm backup:verify --from …` and compare it with the damaged state to learn what changed.
5. If only a few records are affected and the damage is understood, a developer can prepare a reviewed repair. Otherwise restore production from the last good backup (above) and re-enter the gap.
6. If a database password or service-role key may have been misused, rotate it in the Supabase dashboard before resuming.

## Rolling back a failed deployment

The application and the database roll back differently.

- **Application only** (no new migration in the release): redeploy the previous release in the hosting dashboard. Nothing else is needed.
- **Release with a migration**: migrations are forward-only and there are no down-migrations. If the new release misbehaves:
  1. Redeploy the previous application release first. Migrations in this project add tables, columns, functions and indexes; the previous release normally keeps working against the newer schema.
  2. If the previous release does not work against the new schema, or the migration itself damaged data, restore the pre-deployment backup (taken and verified in the deployment runbook, steps 1–2) into a new project and point the previous release at it. Entries made after that backup must be re-entered.
- Never edit or delete a migration that has been applied to production. Fix forward with a new migration.

See [deployment.md](deployment.md) for the full sequence.

## Credentials

- The database URL and the service-role key are the two secrets that bypass every shop restriction. Only the owner and the person operating backups should hold them.
- Keep them in a password manager. Never in the repository, a chat message, a screenshot or a `NEXT_PUBLIC_` variable.
- The service-role key is used only by `scripts/backup.mjs` on the operator's computer. The deployed application does not have it and does not need it.
- Rotate both after anyone who held them leaves, and after any suspected exposure.
- Encrypt backup folders before they leave the computer.

## When a backup or restore fails

| Message | Meaning and action |
| --- | --- |
| `The local Supabase stack is not running` | Start Docker, then `pnpm exec supabase start` |
| `supabase db dump failed` | Wrong or unreachable database URL, wrong password, or Docker not running. The URL is never printed; check it yourself |
| `The database changed while it was being dumped` | Someone saved an entry. Run again when the shop is idle |
| `receipt record(s) have no matching file in storage` | A receipt file is missing in production. Recover it from an older backup, then back up again |
| `does not match the hash recorded when the backup was taken` | The backup folder is damaged or was edited. Use another copy |
| `The backup was taken at a migration state this checkout does not contain` | Check out the release named in `manifest.app.gitCommit` |
| `The restored state does not reconcile with the backup` | The differing tables and totals are listed. This backup must not be relied on; keep it and investigate |
| `ISOLATION_FAILED` | A restored account can see another shop. Do not use this restore |
