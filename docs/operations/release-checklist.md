# ShopKhata release checklist

This checklist is for a named release commit/tag. It does not deploy. A person must separately authorize and run the deployment procedure in [deployment.md](deployment.md).

## Candidate identity and clean install

From the release checkout in PowerShell:

```powershell
git status --short
git rev-parse HEAD
git describe --tags --exact-match
pnpm install --frozen-lockfile
```

Record the full commit and exact tag. Stop if the tree contains unexpected changes, the tag is missing, or frozen install fails. Never stage unrelated `_tmp_*`, screenshots, plans or local evidence as part of a release.

## Automated release gates

Run the complete local gate:

```powershell
pnpm verify:release
```

It performs frozen install, lint, typecheck, unit tests, production build and `git diff --check`. When a local Supabase runtime is available, it also runs pgTAP, DB lint, migration-upgrade, repository integration suites and serial Playwright. Without that runtime it exits `2` and labels those database/browser gates `NOT EXECUTED`; this is not a release pass. It never resets a database or deploys. Then run:

```powershell
pnpm audit --prod
pnpm audit
pnpm exec supabase db reset --local
pnpm exec supabase test db --local
pnpm exec supabase db lint --local --level warning --fail-on error
pnpm exec playwright test --workers=1
```

The reset command permanently resets the **local** Supabase project. Verify `pnpm exec supabase status` identifies the disposable local project first; never substitute a production database URL. Capture command output and Playwright's exit code. No critical test may be unexpectedly skipped. Review production and development audit findings separately; record package, severity, dependency path, and disposition. Do not update unrelated dependencies in the release candidate.

## Build and production-mode acceptance

Provide the local Supabase URL and a publishable local key to the local process only, then run:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:55321"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "<local publishable key>"
$env:SHOPKHATA_ENV = "local"
pnpm build
pnpm start -p 3100
```

In a second terminal run `pnpm smoke:production -- http://localhost:3100 --allow-local` for the local production build. The explicit flag is accepted only for loopback HTTP. The smoke is read-only. For production use `pnpm smoke:production -- https://YOUR-PRODUCTION-DOMAIN`. For local browser checks use Playwright's production PWA project, which builds and serves on port 3100.

Verify login/logout, unauthenticated redirects, owner/staff role access, shop isolation, core read pages, manifest/icons, service worker, offline draft recovery, reconnect, and browser console/server output. Record Chromium, Firefox, WebKit, mobile-sized Chromium, and actual-device results separately. A physical install is a pilot check, not claimed by automated browser coverage.

## Database and security gates

Review migration filenames in lexical order and compare with `supabase migration list`. Confirm no duplicate versions, no edits to already-applied migrations, and no destructive operation without an explicit reviewed requirement. Use a disposable local project for clean reset and pgTAP. Run `pnpm test:migration-upgrade` from the release candidate. Inspect grants, RLS, private receipt policies, RPC execution grants, and query plans for invoice/payment pagination and dashboard/report RPC paths.

Review auth and storage acceptance in [production-checklist.md](production-checklist.md): unauthenticated protected route, disabled user, staff role, changed assignment, cross-shop reads, receipt denial, logout, and owner-only admin. Do not infer database enforcement from hidden UI controls.

## Backup and restore gate

Before a production migration, run `pnpm backup:db`, copy the complete folder to encrypted off-host storage, and run `pnpm backup:verify --from <backup-folder>` on the exact release checkout. Confirm `RESTORE VERIFIED`, read `restore-verification.json`, and retain the evidence. The verifier resets only the local Supabase database; after it finishes, the local database contains the backup data. See [backup-restore.md](backup-restore.md).

## Acceptance record

Keep a release record outside the repository containing release tag/commit, operator, UTC date, exact gate results and exit codes, dependency audit disposition, backup manifest path/hash, migration range, app smoke result, known limitations, and go/no-go decision. Never include secret values. A blocked gate means no deployment.
