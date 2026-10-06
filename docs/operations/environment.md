# ShopKhata environment and secrets

`.env.example` lists every variable name. This page says what each is for, who may see it, and where it is set.

## The variables

| Variable | Class | Where it is set | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe, required | Hosting settings; `.env.local` for development | The Supabase project the application talks to |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe, required | Hosting settings; `.env.local` for development | The publishable (anon) key. It grants nothing by itself: every table is protected by row-level security and every write goes through an authorizing database function |
| `SHOPKHATA_ENABLE_HSTS` | Deployment-only, optional | Hosting settings | `true` sends `Strict-Transport-Security`. Enable only when the final domain is served over HTTPS |
| `SHOPKHATA_BACKUP_ENV` | Operator-only | Shell, one session | Label written into the backup name and manifest, e.g. `production` |
| `SHOPKHATA_BACKUP_DB_URL` | Operator-only, **secret** | Shell, one session | Database connection string of the project being backed up |
| `SHOPKHATA_BACKUP_SUPABASE_URL` | Operator-only | Shell, one session | API URL of the project being backed up (to download receipts) |
| `SHOPKHATA_BACKUP_SERVICE_ROLE_KEY` | Operator-only, **secret** | Shell, one session | Service-role key of the project being backed up |
| `SHOPKHATA_BACKUP_DIR` | Operator-only, optional | Shell | Backup destination folder (must be outside the repository) |
| `SHOPKHATA_RESTORE_SUPABASE_URL` | Operator-only | Shell, one session | API URL of the project receipts are being restored into |
| `SHOPKHATA_RESTORE_SERVICE_ROLE_KEY` | Operator-only, **secret** | Shell, one session | Service-role key of that project |
| `CI` | Local/CI-only | Set by the CI system | Makes Playwright start its own servers and retry |
| `SHOPKHATA_RELEASE` | Server-only, optional | Hosting runtime/build settings | Short release identifier exposed by `/api/health`; use a tag or commit, never a secret |
| `SHOPKHATA_ENV` | Server-only deployment profile (defaults to production if omitted) | `local`, `test`, or `production` | Selects the Supabase URL validation profile for a production-mode build. Hosting should explicitly set `production`; use `local` only for a local production-build/PWA rehearsal |

`NODE_ENV` is assigned by Next.js (`development`, `test` in test runners, `production` for build/start); do not set it to choose a Supabase project. The hosting platform's canonical application URL is the base URL. It is intentionally not duplicated as an app environment variable: use that exact HTTPS origin in Supabase Auth's Site URL and redirect allowlist. There are no auth callback secrets because login is password-based and session cookies are managed by `@supabase/ssr`.

## Environment boundaries

| Environment | App URL and Supabase | Identity/data | Commands and restrictions |
| --- | --- | --- | --- |
| Local development | `http://localhost:3000`; local Supabase URL/key from `pnpm exec supabase status` | Local-only seed accounts and disposable data | `pnpm dev`; never point seeds/resets at a hosted project |
| Test/CI | Local Supabase project and documented public local keys; Playwright starts app servers | Isolated fixture users and shops | `pnpm test`, integration scripts, `pnpm exec playwright test --workers=1`; test credentials are not hosting variables |
| Production | Hosting-assigned HTTPS domain; production Supabase URL and publishable key | Real owner/staff, real data; public signup disabled | Production build/start; no seed, local reset or test account creation. Database and service-role credentials stay with operators for backup/restore only |

Next.js inlines every `NEXT_PUBLIC_*` value into browser bundles at build time. Changing either Supabase public variable requires a new build. Production `next build` and `next start` validate presence and structure, reject secret-looking public names, reject service-role keys, and reject a local Supabase URL. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are browser-safe app variables.

## Complete repository environment inventory

The app and scripts use these environment names (the screenshot crawler under `tools/shopkhata-screenshot-crawler` is a local-only artifact, not release automation):

| Names | Classification | Use |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe; required to build/start all app modes; environment-specific | Supabase endpoint and publishable/anon key |
| `SHOPKHATA_ENABLE_HSTS` | Deployment-only optional | Adds HSTS after final HTTPS domain is confirmed |
| `SHOPKHATA_RELEASE`, `VERCEL_GIT_COMMIT_SHA` | Server-only optional metadata | Release identifier at health endpoint; fallback is `unknown` |
| `SHOPKHATA_BACKUP_ENV`, `SHOPKHATA_BACKUP_DB_URL`, `SHOPKHATA_BACKUP_SUPABASE_URL`, `SHOPKHATA_BACKUP_SERVICE_ROLE_KEY`, `SHOPKHATA_BACKUP_DIR` | Operator-only; DB URL and service-role key secret | Remote backup source and destination; never app-hosting config |
| `SHOPKHATA_RESTORE_SUPABASE_URL`, `SHOPKHATA_RESTORE_SERVICE_ROLE_KEY` | Operator-only; service-role key secret | Explicit receipt restore command only |
| `CI` | Test-only | Playwright worker/retry/server behavior |
| `ComSpec`, `PATH` | OS/runtime-provided, not app configuration | Windows integration subprocesses and CLI resolution |
| `SHOPKHATA_URL`, `SHOPKHATA_SCREENSHOT_SET`, `SHOPKHATA_CRAWLER_EMAIL`, `SHOPKHATA_CRAWLER_PASSWORD`, `CRAWLER_WIDTH`, `CRAWLER_HEIGHT`, `CRAWLER_MAX_PAGES` | Local-only crawler inputs | Optional screenshot-crawler target and fixtures; never production release inputs |
| `NODE_ENV` | Runtime-controlled | Next.js mode; production mode enables deploy validation |

`SUPABASE_AUTH_*` names in `supabase/config.toml` refer to optional local-stack provider integrations only. They are not required by the production password-login path. Production Auth, database SSL/backups, and `expense-receipts` bucket settings are configured and verified in the Supabase project dashboard as described below.

## Runtime/toolchain contract

- Node.js 22 (matches `.github/workflows/ci.yml`).
- pnpm 11.23.0 (the `packageManager` value in `package.json`).
- `pnpm install --frozen-lockfile`; do not update the lockfile during release install.
- Next.js 16.3.8 / React 19.2.8 from the lockfile. Run the tracked production build with the target environment config.
- Supabase CLI 2.115.0 from the locked project dependency (`pnpm exec supabase`); Docker Desktop is required for local DB reset, tests and restore rehearsal. No global CLI is required.
- Production hosting must support the locked Next.js Node runtime, HTTPS, dynamic App Router pages/Server Actions, response headers, runtime environment configuration, and retaining server logs. Configure Supabase Auth's Site URL/redirects to the exact deployed origin.

There are **no server-only application secrets**. The deployed application runs every request as the signed-in user with the publishable key; it never holds the service-role key, a database password or a JWT secret. Account administration is done by owner-only database functions, not by a privileged key.

## Rules

- **`NEXT_PUBLIC_*` values are public.** They are compiled into the JavaScript every browser downloads. Never give that prefix to a secret.
- **The service-role key and the database URL bypass every shop restriction.** They exist only in the operator's shell for the minutes a backup or restore takes, and in a password manager. Not in `.env.local`, not in the hosting settings, not in CI.
- `.env*` files are ignored by git (except `.env.example`). Do not force-add one.
- Local development values come from the local Supabase stack (`pnpm exec supabase status`). They are fixed, publicly known demo keys and must never be used for a hosted project. The seed accounts in `supabase/seed.sql` (`*@shopkhata.local`) exist only locally; `supabase db push` does not run the seed, so they never reach production.

## What happens when configuration is wrong

`next build` and `next start` check the configuration first and stop with a list of problems (`lib/deployment-config.ts`):

- a required variable is missing or the URL is malformed;
- the URL is not `https` (only `localhost`/`127.0.0.1` may be `http`);
- the publishable-key variable holds a service-role or `sb_secret_` key;
- any `NEXT_PUBLIC_` variable is named like a secret (`SERVICE_ROLE`, `SECRET`, `PASSWORD`, `DB_URL`).

A deployment with bad configuration therefore fails at build time, visibly, instead of serving a broken or leaking application. The values are read at build time: **changing either `NEXT_PUBLIC_` variable requires a rebuild and redeploy.**

## Response headers

Set for every response in `next.config.ts`:

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | scripts, styles, images and fonts from this origin only; connections only to this origin and the configured Supabase project; no plugins; no embedding; forms post only to this origin | Limits what an injected script could load or where data could be sent |
| `X-Content-Type-Options` | `nosniff` | Browsers must not guess content types |
| `X-Frame-Options` / `frame-ancestors` | `DENY` / `'none'` | The application cannot be embedded in another site (clickjacking) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Paths and IDs are not sent to other sites |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb disabled | The application uses none of them. Receipt photos use the normal file picker, which this does not affect |
| `Strict-Transport-Security` | one year, only with `SHOPKHATA_ENABLE_HSTS=true` | Forces HTTPS once the domain supports it |

The policy keeps `'unsafe-inline'` for scripts and styles because this Next.js version emits inline bootstrap scripts and the application uses inline styles; a nonce-based policy would force every page to render dynamically. Scripts are still restricted to the application's own origin.

## Supabase project settings that are not in the repository

`supabase/config.toml` configures only the local stack. Set these in the hosted project's dashboard (they are on the production checklist):

- Authentication → **disable public sign-ups**. Accounts are created by the owner.
- Authentication → site URL and redirect URLs: the production domain only.
- Authentication → minimum password length 12 or more.
- Database → enforce SSL.
- Enable automatic backups (paid plan).

## Secret scan performed for this release

The current tree and the full git history were searched for Supabase keys (JWT and `sb_secret_`/`sbp_` forms), JWT secrets, database URLs with passwords, private keys, GitHub/AWS/API tokens, committed `.env` files and database dumps. Result: none found. The only `.env` file ever committed is `.env.example` (names only), and `supabase/.temp` is ignored. The seed file contains passwords for the four local-only test accounts by design.

If a secret is ever found in the repository or its history: **rotate it in the Supabase dashboard first.** Deleting the file or rewriting history does not make an exposed secret safe.
