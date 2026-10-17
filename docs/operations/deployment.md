# ShopKhata deployment runbook

The safe order for putting a release into production. Do the steps in order and do not skip one because the release "is small". A deployment is a deliberate human decision: nothing in the repository or CI deploys to production by itself.

Use the [production checklist](production-checklist.md) for the first deployment; this runbook is the sequence for every deployment.

## Before you start

- The release is an immutable tag whose CI run is green and whose exact commit passed [release-checklist.md](release-checklist.md).
- You have read the release's verification document in `docs/release/` and its list of manual checks.
- Deploy outside trading hours, after the daily close.
- You have, in a password manager and not in any file: the production database URL and the service-role key.
- Docker is running on the operator's computer.

```
git fetch --tags
git checkout <release tag>
pnpm install --frozen-lockfile
pnpm verify:release
```

## 1. Back up production

```
pnpm backup:db        # with the SHOPKHATA_BACKUP_* variables set for this shell session
```

Must end with `Backup complete: <folder>`. Copy the folder to off-host storage now, before changing anything. If the backup fails, stop: do not deploy without one.

## 2. Verify the backup

```
pnpm backup:verify --from <backup folder>
```

Must end with `RESTORE VERIFIED`. This rebuilds the backup on your computer and proves the tables, the financial totals of both shops, the receipt files and the shop isolation all match. A backup that fails this is not a rollback point; stop and investigate.

(If the release adds migrations that the backup does not have, check out the previously deployed tag for this step, then return to the new tag.)

## 3. Verify the target and the environment

- The database URL you are about to use belongs to the **production** project (compare the project ref in the URL with the dashboard).
- `pnpm exec supabase migration list --db-url "<production database URL>"` — every migration already applied remotely exists locally, and the only differences are new migrations of this release.
- Hosting settings hold `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for production, and nothing secret ([environment.md](environment.md)).
- Tell staff the system is being updated and nobody should be entering data.

## 4. Apply migrations

```
pnpm exec supabase db push --db-url "<production database URL>" --dry-run   # read what it will do
pnpm exec supabase db push --db-url "<production database URL>"
```

Migrations are forward-only and each runs in a transaction: one that fails changes nothing. If one fails, **stop**; do not deploy the application; read the error; production is still on the previous schema and the previous release keeps working.

Never run `supabase db reset` against production. It deletes everything.

## 5. Deploy the application

Deploy the release tag through the hosting platform (promote the build of that tag, or trigger a deployment from it). The build stops with `ShopKhata configuration is not deployable` if a required variable is missing or a secret key was put in a public variable; fix the settings and build again.

**Release identity and the clean-tree rule.** `/api/health` reports the deployment's own `VERCEL_GIT_COMMIT_SHA` as `release`; `SHOPKHATA_RELEASE` is only a fallback for hosts that set no commit SHA, so leave it unset on Vercel. The SHA is also set for a CLI deployment (`vercel deploy --prod --skip-domain`, checked on a probe deployment), but there it is read from the local git `HEAD`, not from the uploaded files. It therefore identifies the exact artifact **only if the working tree is clean and committed**. Production-target deployments must be built from a clean, committed working tree (`git status --porcelain` prints nothing, and `HEAD` is the release commit). A dirty tree makes the reported SHA name a commit that is not what was built.

Observed Vercel behaviour: `--skip-domain` leaves `shopkhata.vercel.app` on its current deployment, but the project alias `shopkhata-muzzammels-projects.vercel.app` moves to the new staged deployment. That alias is the Vercel-Auth-protected staging address, so its movement is expected and is not a release problem. Promote only deliberately (`vercel promote <deployment> --scope muzzammels-projects`), after the staged `/api/health` shows the expected SHA.

Because migrations are applied first, there is a short window in which the previous application runs against the new schema. Do not assume the previous release remains compatible: the release record must include an explicit old-app/new-schema compatibility review and test evidence for the exact migration range. If compatibility is uncertain, schedule a maintenance window and prevent writes until the new app is verified.

## 6. Smoke test

Open the production site in a fresh browser window.

- The sign-in page loads over HTTPS.
- Developer tools → Network → the page response has `content-security-policy` and `x-frame-options: DENY`.
- Run the safe read-only smoke: `pnpm smoke:production -- https://YOUR-PRODUCTION-DOMAIN`. It checks HTTPS, security headers, PWA manifest/icons, no-cache service worker, release health endpoint, and unauthenticated protected-route redirect. It never signs in or writes financial data.

## 7. Verify authentication

- The owner signs in and reaches the workspace.
- A wrong password shows "Unable to sign in with those credentials." and nothing else.
- Sign out; opening `/reports` returns to the sign-in page.

## 8. Verify the shops

- The owner sees both shops in the shop switcher.
- One staff account per shop signs in and sees only its own shop.

## 9. Verify key reads

For each shop, as the owner:

- the workspace lists recent invoices;
- Customers opens, and one customer's ledger opens;
- Reports → Daily summary and Customer due open;
- the Customer due total equals `shops.<shop id>.customer_due_totals.outstanding_due_dirham ÷ 100` in the backup's `manifest.json` from step 1 (nothing was entered since).

## 10. Verify one controlled write

As the owner, in one shop, record an expense of QAR 0.01 described "Deployment check <date>". Confirm it appears in the expense list and in today's daily summary. Leave it in place: it is an honest, labelled record, and financial entries cannot be deleted. (Skip this step if the owner prefers no test entry; then watch the first real entry of the next trading day instead.)

## 11. Verify the backup schedule

- Supabase dashboard → Database → Backups shows the automatic backups enabled and a recent one.
- The person responsible for `pnpm backup:db` knows the next one is due after the next daily close.

## 12. Monitor

During the first trading day on the new release:

- Hosting platform logs: search for `"app":"shopkhata"`. A `"level":"warn"` line is a rule the database enforced (a closed date, an unauthorized shop); a `"level":"error"` line means a result was not confirmed and needs a look. Lines carry the operation, the error code, the shop and the account ID — never amounts, names or payloads.
- Supabase dashboard → Logs → Postgres, for errors and slow statements.
- Ask staff at the end of the day whether anything behaved differently.

What each failure looks like to the user and in the log:

| Failure | What the user sees | Where to look |
| --- | --- | --- |
| A save rejected by a rule | A plain message naming the rule ("This business date is closed.") | `warn` line with the code |
| A save with no confirmed answer | "…status is uncertain. Retry the same…"; the entry stays on screen and retries with the same key, so it cannot be saved twice | `error` line for that operation |
| Receipt upload failed | "Expense recorded. Receipt upload failed; retry the same expense to attach it." | `register_expense_attachment` line; Storage logs |
| Offline draft rejected on reconnect | The draft is kept on the device with the reason | `submit_batch` line with the code |
| Export failed | "The export could not be prepared. Try again." | `export:<kind>` line |
| Missing configuration | The build fails; nothing is deployed | Build log: `ShopKhata configuration is not deployable` |
| Backup or restore failed | `[backup] FAILED: …` and a non-zero exit | The message; table in [backup-restore.md](backup-restore.md) |

## 13. Rollback

Decide quickly; a half-working system during trading hours costs more than a rollback.

**The application misbehaves, the data is fine** (the usual case)

1. In the hosting platform, redeploy the previous release. This takes effect immediately.
2. Leave the new migrations in place. They only add things; the previous release runs against them.
3. Record what went wrong and fix it in a new release.

**A migration failed in step 4**

Nothing changed. Do not deploy. Fix the migration in a new commit and start again from step 1.

**Data was damaged, or the previous release cannot run against the new schema**

1. Stop entries.
2. Restore the step 1 backup into a **new** Supabase project following [backup-restore.md](backup-restore.md), "Restoring production", from a checkout of the previously deployed tag.
3. Point the previous release at the restored project and redeploy.
4. Re-enter anything recorded after the backup, using the owner's backdated entry with a reason.

Never edit or delete an applied migration, and never repair financial rows by hand in the SQL editor.

## After a successful deployment

- Take a fresh backup the same evening and store it off-host.
- Keep the step 1 backup until the next release is confirmed good.
- Note the deployed tag, the date and the person in whatever log the shop keeps.
