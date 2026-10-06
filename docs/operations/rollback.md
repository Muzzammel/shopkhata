# Production rollback

Rollback is a release decision by the owner/operator. ShopKhata does not deploy or roll back automatically.

## Application rollback

For a server/application defect with intact data:

1. Stop or pause affected writes if their outcome is uncertain.
2. Identify the last known-good deployed tag and full commit from the release record and `/api/health`.
3. Read that release's migration list and compare it with the production migration history.
4. Verify the older application can run on the current database: check whether intervening migrations renamed/dropped/changed objects, altered RPC signatures/behavior, constraints, grants, or data shape used by the old release. Confirm against that release's integration and acceptance suite on a disposable database built at the current production migration version where possible.
5. If compatible, redeploy the previous immutable build/tag through the host and run the read-only production smoke plus owner/staff read checks. Keep the new database schema and preserve all records.
6. Log the decision, commit, migration range, smoke result, and follow-up. Fix forward in a newly reviewed release.

RC4 (`shopkhata-v1-rc4`, commit `3cda725045d27ae1e974f1622144eb52839088fe`) is the known-good pre-production recovery checkpoint for this slice. It is **not** automatically assumed compatible after future migrations. Recheck actual migration history and app behavior each time.

## Database recovery

Migrations are forward-only. Never run a guessed down migration, manually edit production rows, or assume deploying old app code reverses a migration. Prefer a reviewed forward fix when data is intact.

Restore is for severe loss/corruption or an incompatible migration when forward recovery is not safe:

1. Stop writes and preserve current logs/state evidence; take a backup of the current state if possible.
2. Select and locally verify a complete database-plus-receipt backup with `pnpm backup:verify --from <folder>`.
3. Restore to a new Supabase project following [backup-restore.md](backup-restore.md). Avoid overwriting the damaged project.
4. Validate migrations, fingerprint, shop totals, owner login, staff shop isolation, and receipt access before pointing the app to it.
5. Deploy an application release verified compatible with that restored schema; configure Auth URLs and public app keys; require all users to sign in again.
6. Re-enter post-backup legitimate activity from source documents using approved business-date/correction workflows. Never delete immutable records to tidy up.

## Decision record

Record incident reference, decision owner, old/new release identifiers, deployed migration range, compatibility evidence, backup manifest identity (no secrets), data gap and re-entry plan, smoke result, and resume time. A successful app rollback does not prove database rollback or restore success.
