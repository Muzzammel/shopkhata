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

## Restoring production

Do this only when the production data is lost or damaged beyond repair. Stop, breathe, and follow the order.

1. **Stop new entries.** Tell staff to stop. Take the application offline or leave it; do not let anyone keep writing to a damaged database.
2. **Pick the backup.** The newest one from before the damage. Rehearse it first: `pnpm backup:verify --from <backup dir>` must end with `RESTORE VERIFIED`.
3. **Decide the target.** Prefer a **new Supabase project** (same region, PostgreSQL 17). Restoring over the damaged project destroys the evidence and cannot be undone.
4. **Check out the release that took the backup**: `git checkout <manifest.app.gitCommit>` and `pnpm install --frozen-lockfile`.
5. **Build the schema from the migrations**: `pnpm exec supabase db push --db-url "<new database URL>"`.
6. **Load the data** (the migrations create the empty receipt bucket, which the backup replaces):

   ```
   docker run --rm -i -v "<backup dir>:/backup" public.ecr.aws/supabase/postgres:17.6.1.159 psql "<new database URL>" -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; delete from storage.objects; delete from storage.buckets;"
   docker run --rm -i -v "<backup dir>:/backup" public.ecr.aws/supabase/postgres:17.6.1.159 psql "<new database URL>" -v ON_ERROR_STOP=1 --single-transaction -f /backup/data.sql
   docker run --rm -i public.ecr.aws/supabase/postgres:17.6.1.159 psql "<new database URL>" -c "analyze"
   ```

   The load is one transaction: it either completes or changes nothing. **Do not skip `analyze`** — without it the invoice screens are slow enough to time out until the database gathers statistics on its own (found in the restore rehearsal).
7. **Restore the receipt files**:

   ```
   SHOPKHATA_RESTORE_SUPABASE_URL=https://<new ref>.supabase.co
   SHOPKHATA_RESTORE_SERVICE_ROLE_KEY=<new project's service-role key>
   node scripts/backup.mjs restore-receipts --from <backup dir> --confirm <new ref>.supabase.co
   ```

   Each file is uploaded under its original path and read back; the command fails on the first mismatch.
8. **Validate before anyone uses it** (next section).
9. **Point the application at the new project**: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the hosting settings and redeploy. Set the Auth site URL in the new project. Everyone must sign in again.
10. **Re-enter what was lost.** Anything saved after the backup was taken is gone. Use paper records and the owner's backdated-entry workflow (with a reason) to re-enter it. Drafts still sitting on a device were never saved and will be sent when the device reconnects.
11. Take a fresh backup of the restored system and store it off-host.

Steps 5–7 against a *hosted* project follow Supabase's documented restore procedure and the commands the local rehearsal runs, but have not been executed against a hosted project by this release's verification. Rehearse them once against a scratch Supabase project before go-live (see the production checklist).

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
- On restore, `data.sql` brings back both `public.attachments` and Storage's own index (`storage.objects`); `restore-receipts` then puts the bytes back under the same paths. The rehearsal proves each record has its file at the recorded size.
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
