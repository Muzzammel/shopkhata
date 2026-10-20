import { Suspense, type ComponentProps, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { DatabaseBackupIcon, FileCheck2Icon, HistoryIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { BACKUP_OVERDUE_HOURS, formatBytes, summarizeBackups, type BackupEntry } from "@/lib/backup-status";
import { qatarDateTime } from "@/lib/sales-view";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { AdminTabs } from "../admin-tabs";

const age = (hours: number) => hours < 1 ? "less than an hour ago" : hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
const card = cn(ui.card, "grid content-start gap-3 p-5 sm:p-6");
// The word carries the meaning; colour only repeats it.
const badge = "inline-flex h-5 w-fit items-center rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase";
const tone = { good: "bg-success-soft text-success", warn: "bg-warning-soft text-warning", bad: "bg-danger-soft text-destructive", plain: "bg-card text-muted-foreground ring-1 ring-border ring-inset" };

function Rehearsal({ entry }: { entry: BackupEntry }) {
  if (!entry.rehearsal) return <span className={cn(badge, tone.plain)}>Not rehearsed</span>;
  return <span className={cn(badge, entry.rehearsal.ok ? tone.good : tone.bad)}>{entry.rehearsal.ok ? "Restore verified" : "Restore failed"}</span>;
}

const Code = ({ children }: { children: string }) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] [overflow-wrap:anywhere]">{children}</code>;
const Step = ({ n, children }: { n: number; children: ReactNode }) => <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 text-sm"><span aria-hidden className="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{n}</span><span className="pt-1">{children}</span></li>;

export default async function BackupRecoveryPage() {
  const actor = await getCurrentActor();
  // A non-owner gets the same answer as for a page that does not exist. Row-level security
  // on backup_records enforces the same rule in the database. Checked before anything streams.
  if (!can(actor, "users.manage")) notFound();

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="grid min-w-0 gap-1.5 px-1">
      <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Owner only · All shops</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Backup &amp; Recovery</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">What has been backed up, whether it was checked, and how a recovery is carried out. This screen reads the backup record; it cannot change, download or restore data.</p>
    </header>
    <AdminTabs current="/admin/backup" />
    <Suspense fallback={<BackupSkeleton />}><BackupWorkspace /></Suspense>
  </main>;
}

function BackupSkeleton() {
  return <div aria-busy="true" aria-label="Loading backups" className="grid gap-4 sm:gap-5">
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-44 rounded-3xl" />)}</div>
    <Skeleton className="h-64 rounded-3xl" />
  </div>;
}

const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle text-sm lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;

async function BackupWorkspace() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("backup_records").select("*").order("backup_created_at", { ascending: false }).limit(200);
  if (error || !data) throw new Error("ADMIN_WORKSPACE_UNAVAILABLE");
  const summary = summarizeBackups(data, new Date());
  const { latest, latestRehearsed } = summary;
  const current = summary.freshness === "current";

  return <>
    {!current && <Alert className="border-warning/40 bg-warning-soft text-warning">
      <TriangleAlertIcon />
      <AlertTitle>{summary.freshness === "none" ? "No backup has been recorded" : `The latest recorded backup is ${age(summary.ageHours!)}`}</AlertTitle>
      <AlertDescription className="text-foreground">{summary.freshness === "none"
        ? "Either no backup has been taken, or it was not recorded here. Take one and record it using the steps below."
        : `A backup is expected after every trading day's close (at most ${BACKUP_OVERDUE_HOURS} hours apart). Entries made since the latest one are not protected.`}</AlertDescription>
    </Alert>}

    <section aria-label="Backup status" className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div className={cn(card, "bg-card")}>
        <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium text-muted-foreground">Latest backup</span><DatabaseBackupIcon aria-hidden className="size-4 text-muted-foreground" /></div>
        <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">{latest ? qatarDateTime(latest.createdAt) : "None recorded"}</strong>
        {latest ? <>
          <span data-freshness={summary.freshness} className={cn(badge, current ? tone.good : tone.warn)}>{current ? "Current" : "Overdue"}</span>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Taken</dt><dd className="font-semibold">{age(summary.ageHours!)}</dd></div>
            <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Environment</dt><dd className="font-semibold">{latest.environment}</dd></div>
            <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Database dump</dt><dd className="font-semibold tabular-nums">{formatBytes(latest.dumpBytes)}</dd></div>
            <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Receipt files</dt><dd className="font-semibold tabular-nums">{latest.receiptCount}</dd></div>
          </dl>
          <span className="text-xs text-muted-foreground">Times are Qatar time.{latest.appVersion ? ` App version ${latest.appVersion}.` : ""}</span>
        </> : <span className="text-sm text-muted-foreground">Nothing has been recorded on this screen yet. Times are shown in Qatar time.</span>}
      </div>
      <div className={card}>
        <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium text-muted-foreground">File integrity</span><FileCheck2Icon aria-hidden className="size-4 text-muted-foreground" /></div>
        <strong className="text-lg font-semibold">{latest ? "SHA-256 verified" : "Nothing to verify"}</strong>
        {latest ? <>
          <span className={cn(badge, tone.good)}>Hashes matched</span>
          <span className="text-sm text-muted-foreground">Every dump and receipt file matched its recorded hash when checked on {qatarDateTime(latest.integrityCheckedAt)}. A backup whose hashes do not match is refused and never listed.</span>
        </> : <span className="text-sm text-muted-foreground">Hashes are checked each time a backup is recorded.</span>}
      </div>
      <div className={card}>
        <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium text-muted-foreground">Restore rehearsal</span><HistoryIcon aria-hidden className="size-4 text-muted-foreground" /></div>
        <strong className="text-lg font-semibold">{latestRehearsed ? qatarDateTime(latestRehearsed.rehearsal!.at) : "Never rehearsed"}</strong>
        {latestRehearsed ? <>
          <span className={cn(badge, tone.good)}>Restore verified</span>
          <span className="text-sm text-muted-foreground">The backup of {qatarDateTime(latestRehearsed.createdAt)} was restored into a disposable database and reconciled to the last row.</span>
        </> : <>
          <span className={cn(badge, tone.warn)}>Unproven</span>
          <span className="text-sm text-muted-foreground">A backup that has never been restored is not yet proven. Rehearse one at least monthly and before every release.</span>
        </>}
      </div>
    </section>

    <section aria-labelledby="backup-history-heading" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 id="backup-history-heading" className="text-lg font-semibold tracking-tight">Backup history</h2>
        <span className="text-xs text-muted-foreground">{summary.entries.length === 0 ? "None recorded" : `${summary.entries.length} backup${summary.entries.length === 1 ? "" : "s"} recorded · newest first`}</span>
      </div>
      {summary.entries.length === 0 ? <div className="grid justify-items-center gap-2 rounded-3xl border border-dashed border-input bg-card px-6 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-muted"><DatabaseBackupIcon aria-hidden className="size-5 text-muted-foreground" /></span>
        <p className="font-semibold">No backup has been recorded.</p>
        <p className="max-w-md text-sm text-muted-foreground">Once the operator records a backup with <Code>pnpm backup:record</Code>, it is listed here with its integrity check and any restore rehearsal.</p>
      </div> : <div className="rounded-3xl border-border lg:border lg:bg-card">
        <table data-slot="backup-table" className="w-full border-separate border-spacing-0 tabular-nums max-lg:block">
          <caption className="sr-only">Recorded backups, newest first</caption>
          <thead data-slot="head" className="max-lg:sr-only"><tr data-slot="row">
            <Th className="rounded-tl-3xl">Taken (Qatar time)</Th><Th>Environment</Th><Th className="text-right">Size</Th><Th className="text-right">Receipts</Th><Th>Integrity</Th><Th>Restore rehearsal</Th><Th className="rounded-tr-3xl">Manifest SHA-256</Th>
          </tr></thead>
          <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">{summary.entries.map((entry, index) => <tr key={entry.manifestSha256} data-slot="row" data-backup={entry.manifestSha256} data-latest={index === 0 || undefined} className="max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-4 max-lg:gap-y-2 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
            <Td className="font-medium max-lg:col-span-2 max-lg:text-[15px]"><span className="inline-flex flex-wrap items-center gap-2">{qatarDateTime(entry.createdAt)}{index === 0 && <span className={cn(badge, "bg-primary text-primary-foreground")}>Latest</span>}</span></Td>
            <Td><span className="text-xs text-muted-foreground lg:hidden">Environment </span>{entry.environment}{entry.appVersion ? ` · v${entry.appVersion}` : ""}</Td>
            <Td className="text-right"><span className="text-xs text-muted-foreground lg:hidden">Size </span>{formatBytes(entry.dumpBytes)}</Td>
            <Td className="text-right max-lg:text-left"><span className="text-xs text-muted-foreground lg:hidden">Receipts </span>{entry.receiptCount}</Td>
            <Td className="max-lg:justify-self-end"><span className={cn(badge, tone.good)}>Hashes matched</span></Td>
            <Td className="max-lg:col-span-2"><span className="inline-flex flex-wrap items-center gap-2"><Rehearsal entry={entry} />{entry.rehearsal && <span className="text-xs text-muted-foreground">{qatarDateTime(entry.rehearsal.at)}</span>}</span></Td>
            <Td className="font-mono text-xs text-muted-foreground max-lg:col-span-2" title={entry.manifestSha256}><span className="font-sans lg:hidden">Manifest </span>{entry.manifestSha256.slice(0, 16)}…</Td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p className="px-1 text-[13px] text-muted-foreground">Only backups the operator has recorded appear here. The backup folders themselves are kept off this system, by design.</p>
    </section>

    <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
      <section aria-labelledby="backup-take-heading" className={card}>
        <h2 id="backup-take-heading" className="text-lg font-semibold tracking-tight">Taking and keeping a backup</h2>
        <p className="text-sm text-muted-foreground">Backups are created and held outside this application, by the person who operates ShopKhata, on a trusted computer. Creating or downloading one from this screen is intentionally not offered: it would need the database password and the service key inside the web application, and a backup stored in the same account as the data it protects is not a safe backup.</p>
        <ol className="grid list-none gap-3 pl-0">
          <Step n={1}>After the daily close, run <Code>pnpm backup:db</Code> with the operator variables set for that session.</Step>
          <Step n={2}>Copy the whole backup folder to storage outside the database and hosting accounts.</Step>
          <Step n={3}>Run <Code>pnpm backup:record --from &lt;backup folder&gt;</Code>. It re-checks every file hash, then lists the backup here.</Step>
          <Step n={4}>At least monthly, run <Code>pnpm backup:verify --from &lt;backup folder&gt;</Code> and record the backup again to show the rehearsal result.</Step>
        </ol>
      </section>

      <section aria-labelledby="recovery-heading" className={card}>
        <h2 id="recovery-heading" className="text-lg font-semibold tracking-tight">Recovery workflow</h2>
        <Alert variant="destructive" className="border-destructive/50 bg-danger-soft">
          <ShieldAlertIcon />
          <AlertTitle>Restoring production is not available from the browser</AlertTitle>
          <AlertDescription>A restore replaces every invoice, payment and account. It is a controlled procedure carried out by the operator from the runbook, with the owner&apos;s authorization, into a new database, never a button on this page.</AlertDescription>
        </Alert>
        <ol className="grid list-none gap-3 pl-0">
          <Step n={1}><strong>Stop new entries.</strong> Nobody keeps writing to a damaged database.</Step>
          <Step n={2}><strong>The owner authorizes the restore and names the backup.</strong> {latestRehearsed
            ? <>The newest backup with a verified rehearsal is {qatarDateTime(latestRehearsed.createdAt)} (manifest <Code>{latestRehearsed.manifestSha256.slice(0, 16)}</Code>).</>
            : <>No recorded backup has a verified rehearsal yet.</>}</Step>
          <Step n={3}><strong>Verify integrity and rehearse.</strong> <Code>pnpm backup:verify --from &lt;backup folder&gt;</Code> must end with RESTORE VERIFIED.</Step>
          <Step n={4}><strong>Restore into a new database project,</strong> not over the damaged one, following the runbook step by step. The receipt-file step requires the target host to be typed again as confirmation.</Step>
          <Step n={5}><strong>Validate before anyone signs in:</strong> the restored totals must equal the manifest for every shop.</Step>
          <Step n={6}><strong>Point the application at the restored project,</strong> re-enter what was saved after the backup, then take and record a fresh backup.</Step>
        </ol>
        <p className="border-t border-border pt-3 text-[13px] text-muted-foreground">Everything saved after the chosen backup is lost and must be re-entered from paper records. The full procedure is in the operations runbook: <Code>docs/operations/backup-restore.md</Code>. Keep a printed copy.</p>
      </section>
    </div>

    <section aria-labelledby="backup-safety-heading" className={cn(ui.card, "grid gap-3 p-5 sm:p-6")}>
      <h2 id="backup-safety-heading" className="text-lg font-semibold tracking-tight">Safety rules</h2>
      <ul className="grid list-none gap-3 pl-0 text-sm sm:grid-cols-2 [&>li]:content-start">
        <li className="grid gap-0.5"><strong>Backups are separate from shop records.</strong><span className="text-muted-foreground">Nothing on this screen adds, edits or removes an invoice, payment, expense or account.</span></li>
        <li className="grid gap-0.5"><strong>Recovery is privileged.</strong><span className="text-muted-foreground">Only the owner authorizes it, and only the operator, holding the database credentials, carries it out.</span></li>
        <li className="grid gap-0.5"><strong>A production restore is always deliberate.</strong><span className="text-muted-foreground">It goes into a new project after a verified rehearsal, never over live data.</span></li>
        <li className="grid gap-0.5"><strong>The record cannot be rewritten.</strong><span className="text-muted-foreground">Backup records are append-only: once listed, an entry cannot be changed or deleted.</span></li>
      </ul>
    </section>
  </>;
}
