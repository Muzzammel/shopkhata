# Production incident response

## First response for every incident

1. Stop the affected operation. For any balance uncertainty, cross-shop data, suspected intrusion or repeated write error, ask staff to stop new entries until the owner decides.
2. Record UTC/local time, affected user/shop, device/browser, route, action attempted, whether a result was confirmed, safe error code and request reference/digest if shown.
3. Preserve hosting logs, Supabase Auth/Postgres/Storage logs, backup manifest and the user's current screen. Redact credentials, tokens, customer details and private receipt URLs.
4. Do not edit database rows, delete immutable history, replay a transaction with a new idempotency key, or restore over the only production project.
5. Owner decides whether to resume, disable an account, rollback application code, or invoke disaster recovery. Record that decision and evidence outside the repository.

| Incident | Immediate safe action | Do not do | Evidence and recovery |
| --- | --- | --- | --- |
| Login/auth issue | Check service status, production URL and Auth configuration; owner tests a separate account. | Do not share/reset another person's password or enable public signup. | Preserve time, account ID/email only in restricted owner notes, auth event/log code; use password reset or revoke the affected session through the supported provider process. |
| One user cannot access a shop | Verify active account, role, assignment and intended shop with an owner. | Do not broaden role/assignment as a quick workaround. | Record account, shop, URL and denial; correct through the audited Accounts workflow, then ask the user to sign in again. |
| Entire app unavailable | Check hosting health/deploy logs and Supabase status; notify staff to stop entries. | Do not redeploy repeatedly or run local reset against production. | Preserve release ID, `/api/health`, timestamps and logs; restore service or roll back application following [rollback.md](rollback.md). |
| Database/RPC error | Pause affected operation; retain the same form and idempotency key; owner checks whether the canonical record exists. | Do not retry as a new invoice/payment or manually repair rows. | Preserve safe request ID/error code and Postgres logs; retry the same operation only after checking its status. Forward-fix code/schema after review. |
| Duplicate or uncertain transaction | Stop related writes and reconcile canonical invoice/payment/customer ledger with owner. | Do not delete either record or submit a compensating guess. | Preserve both references and event times; use governed correction/replacement flow after owner review. |
| Receipt upload failure/missing file | Keep the expense; tell owner which attachment failed and retry against the same expense when online. | Do not create a duplicate expense or expose a public bucket. | Preserve expense ID/path internally and storage error code; owner checks private object, latest backup and restore completeness. |
| PWA stale after deployment | Close/reopen once online; reload the page and sign in again. Keep unsynced draft intact. | Do not clear site storage/cache when a draft may be unsaved. | Record deployed release and browser version; check `/sw.js` cache headers and hosting asset availability. Owner gives time for update or uses browser refresh after protecting draft. |
| Backup failure | Stop and preserve the failed output/folder; rerun only after diagnosing the cause and safe quiet period. | Do not claim the provider's DB backup includes receipts or treat a partial folder as recoverable. | Keep manifest/error and operator time; correct connectivity/storage issue, create a new full backup, verify it, then copy off-host. |
| Suspected unauthorized access | Owner disables the affected account via supported controls, revokes sessions, and pauses writes if scope is unclear. | Do not delete logs, confront from an unverified alert, or share secrets in tickets/chat. | Preserve Auth/admin/audit/hosting logs; rotate suspected credentials from a trusted device; review shop assignments and receipt access. Escalate to Supabase/hosting support as needed. |

## Resume criteria

The owner resumes operations only after access boundaries are checked, uncertain writes are reconciled, the affected release/service is stable, and a complete backup is verified. If database integrity is uncertain, use the restore decision process in [backup-restore.md](backup-restore.md), not manual SQL edits.
