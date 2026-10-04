# ShopKhata production checklist

Work through this top to bottom before the first day of real use, and again (sections 6–10) for every later release. Tick a box only when you have seen the result yourself. Anything you cannot tick is a reason not to go live.

Related: [deployment.md](deployment.md) (the exact sequence), [backup-restore.md](backup-restore.md), [environment.md](environment.md).

## 1. Supabase production project

- [ ] A dedicated Supabase project exists for production. It is not the project used for any testing.
- [ ] PostgreSQL major version is **17** (matches `supabase/config.toml`).
- [ ] The plan includes automatic daily backups, and they are switched on.
- [ ] Authentication → **public sign-ups are disabled**.
- [ ] Authentication → site URL is the production address; no other redirect URL is listed.
- [ ] Authentication → minimum password length is 12 or more.
- [ ] Database → SSL enforcement is on.
- [ ] The database password and the service-role key are stored in a password manager, known only to the owner and the operator.

## 2. Database

- [ ] From a checkout of the release tag: `pnpm exec supabase db push --db-url "<production database URL>"` finished without error.
- [ ] `pnpm exec supabase migration list --db-url "<production database URL>"` shows every migration in `supabase/migrations` as applied, ending with `20261004120000`.
- [ ] The seed file was **not** run. No `@shopkhata.local` account exists: in the SQL editor, `select count(*) from auth.users where email like '%@shopkhata.local';` returns 0.

## 3. Shops and the first owner

Run once in the Supabase SQL editor (it is the only step that is not done inside ShopKhata):

```sql
-- The two shops. Use the real names; they can be told apart on every screen.
insert into public.shops (name) values ('<Shop 1 name>'), ('<Shop 2 name>');
```

Create the owner's sign-in under Authentication → Users → Add user (email + a strong password, "auto confirm"), then:

```sql
insert into public.profiles (id, email, display_name, role, is_active)
select id, email, '<Owner name>', 'owner', true from auth.users where email = '<owner email>';
```

- [ ] `select name, is_active from public.shops;` shows exactly two active shops.
- [ ] `select email, role, is_active from public.profiles;` shows the owner, role `owner`, active.
- [ ] The owner can sign in to the deployed application and sees both shops.
- [ ] A **second owner account** exists (a trusted person), so the shops are never locked out if one owner loses access. An owner cannot change their own role or status; another owner must.

## 4. Staff accounts and shop assignments

For each person: create the sign-in in the Supabase dashboard (Authentication → Users), then in ShopKhata open **Accounts**, register the email with a role, and tick the shop(s).

- [ ] Every person has their own account. No shared logins.
- [ ] Each account's "Effective access" on the Accounts page is what that person should have.
- [ ] Shop 1 staff signed in and cannot see Shop 2 (no Shop 2 in any shop switcher; `/reports?shop=<Shop 2 id>` shows Shop 1).
- [ ] A manager can close today's date; a staff account is not offered the button.
- [ ] "Recent account changes" on the Accounts page lists every registration and assignment you just made.

## 5. Row-level security and storage

- [ ] In the SQL editor: `select count(*) from pg_tables t join pg_class c on c.relname = t.tablename join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname where t.schemaname = 'public' and not c.relrowsecurity;` returns **0** (every table is protected).
- [ ] Storage → bucket `expense-receipts` exists and is **private** (not public), 10 MB limit, JPEG/PNG/WebP/PDF only.
- [ ] `select policyname from pg_policies where schemaname = 'storage' and policyname like 'expense_receipts_%';` returns four policies (read, insert, no update, no delete).
- [ ] A Shop 1 staff account uploaded a receipt with an expense and can open it; a Shop 2 staff account cannot see that expense.

## 6. Environment variables (hosting settings)

- [ ] `NEXT_PUBLIC_SUPABASE_URL` = the production project URL (`https://…supabase.co`).
- [ ] `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the **publishable/anon** key. Not the service-role key.
- [ ] No service-role key, database URL or password is set anywhere in the hosting settings.
- [ ] `SHOPKHATA_ENABLE_HSTS=true` is set only after the final domain serves HTTPS.

## 7. Backup and restore

- [ ] `pnpm backup:db` against production finished with `Backup complete` (variables in [backup-restore.md](backup-restore.md)).
- [ ] The backup folder was copied to at least one place **outside** the Supabase and hosting accounts.
- [ ] `pnpm backup:verify --from <that backup>` finished with `RESTORE VERIFIED` on the operator's computer.
- [ ] **Once before go-live:** the hosted restore procedure (backup-restore.md, "Restoring production", steps 5–7) was rehearsed against a scratch Supabase project and the fingerprint matched. *This has not been done by the release verification; it is a manual check.*
- [ ] Someone is named as responsible for the daily backup, and a calendar reminder exists for the monthly restore rehearsal.

## 8. Domain, HTTPS, build and deploy

- [ ] The production domain serves the application over HTTPS with a valid certificate; `http://` redirects to `https://`.
- [ ] The deployed build is the release tag (`shopkhata-v1-rc1` or later), built by the hosting platform with the variables above. A build with missing variables fails; it did not.
- [ ] Response headers are present: open the site, browser developer tools → Network → the page request shows `content-security-policy`, `x-frame-options: DENY`, `x-content-type-options: nosniff`.

## 9. Browser and device checks (manual)

On the real production site:

- [ ] Chrome or Edge on the shop computer: sign in, enter an invoice, record a payment, record an expense, open a report, export it, sign out.
- [ ] Firefox or Safari, if anyone will use them: the same.
- [ ] A phone-sized screen: sign in, enter an invoice, open a customer ledger. Nothing is cut off.
- [ ] **Install as an app** on the actual shop device(s) — Android Chrome "Install app" / Windows Edge or Chrome "Install ShopKhata". The icon appears, the app opens in its own window and shows the workspace. *Automated checks confirm the install criteria; no physical device was tested by the release verification.*
- [ ] On that device: turn the network off, enter a draft row, turn the network on — the draft is still there and saves once.
- [ ] Turn the network off and reload: the offline page appears with the draft, and no saved financial data is shown.

## 10. Post-deploy smoke test

- [ ] Owner signs in; both shops listed; today's date shown is the Qatar date.
- [ ] One real or clearly labelled test invoice was saved in each shop with the same invoice number, and each shop shows only its own.
- [ ] Reports → Daily summary for today shows that invoice in the right shop only.
- [ ] Daily close: the owner closed and reopened a past date with a reason; the history shows both events.
- [ ] The hosting platform's log shows no `"level":"error"` line from `"app":"shopkhata"` during these steps.
- [ ] Rollback plan agreed: who decides, which previous release, where the pre-deployment backup is ([deployment.md](deployment.md), "Rollback").

## What V1 does and does not do (agreed limits)

Staff should know these before go-live:

- A manager can reopen **today** only. Reopening an earlier date is owner-only.
- Every report is for one shop. There is no combined two-shop report.
- The customer-due report shows the **current** position, not the position "as of" a past date.
- ShopKhata records sales, receipts, dues and expenses. It holds no cost of goods: no figure in it is profit.
- Customers cannot be merged or removed.
- An invoice batch, typed or imported from Excel, holds at most **100 rows**.
- Text typed in the first moment after a page opens, before it becomes interactive, may not register; type it again. (Sign-in and invoice lookup are not affected.)
- Accounts are created in two steps: the sign-in in the Supabase dashboard, then registration under Accounts.
