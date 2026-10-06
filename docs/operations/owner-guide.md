# ShopKhata owner guide

Keep this with the [staff guide](staff-guide.md), [pilot runbook](pilot-runbook.md), and [incident response](incident-response.md).

- **Provision people:** create an individual Auth user with public signup disabled, register the profile under Admin/Accounts, assign only the needed role and shop, then verify effective access as that user. Never use seed scripts for production.
- **Change access:** use the audited account and shop-assignment workflow. To remove access, deactivate/revoke the account and its active sessions through supported controls; verify that a fresh request is denied. A departing person's password is never reassigned.
- **Oversee records:** review invoice/payment/customer ledger, expense/receipt and closing reports. Treat balances as database-derived. Use correction approvals and reasons for mistakes; never edit/delete rows directly.
- **Close:** confirm the Qatar business date, shop, pending activity and totals before a close. Reopen only through the authorized workflow with a clear reason. Keep the close history.
- **Interpret dashboards:** compare like-for-like shop and date ranges. Sales, payments, customer due and expenses are operational totals; ShopKhata does not calculate inventory cost or profit.
- **Back up:** after each trading day's close run `pnpm backup:db`, verify with `pnpm backup:verify --from <folder>`, copy the entire encrypted folder off-host, and record the manifest identity. Keep daily/weekly/monthly copies per [backup-restore.md](backup-restore.md).
- **Restore:** first stop entries, select and verify a complete DB-plus-receipt backup, restore to a new project, compare the manifest fingerprint and shop totals, then verify owner login, staff isolation and receipt reads before reconnecting the app. Do not repair rows manually.
- **Incidents:** follow [incident-response.md](incident-response.md). Pause uncertain financial actions and preserve logs/references. Rotate credentials if exposure is suspected.
- **Staff/device changes:** verify replacement staff's shop and role. Remove old access, revoke sessions, preserve local unsynced drafts with the user, and confirm a backup before wiping a lost/replaced device.
- **Releases:** review the release acceptance record, dependency audit, migration compatibility and verified pre-release backup. Deploy only through [deployment.md](deployment.md), check `/api/health`, run read-only smoke, and retain rollback evidence.
