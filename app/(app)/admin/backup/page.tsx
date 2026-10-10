import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { BACKUP_OVERDUE_HOURS, formatBytes, summarizeBackups, type BackupEntry } from "@/lib/backup-status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { AdminTabs } from "../admin-tabs";
import styles from "@/app/ui.module.css";

const qatarTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar", dateStyle: "medium", timeStyle: "short" });
const age = (hours: number) => hours < 1 ? "less than an hour ago" : hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
const tone = { good: "bg-success-soft text-success", warn: "bg-warning-soft text-warning", bad: "bg-danger-soft text-destructive" };

function Rehearsal({ entry }: { entry: BackupEntry }) {
  if (!entry.rehearsal) return <Badge variant="outline">Not rehearsed</Badge>;
  return <Badge className={entry.rehearsal.ok ? tone.good : tone.bad}>{entry.rehearsal.ok ? "Restore verified" : "Restore failed"}</Badge>;
}

const Code = ({ children }: { children: string }) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] break-all">{children}</code>;

export default async function BackupRecoveryPage() {
  const actor = await getCurrentActor();
  // A non-owner gets the same answer as for a page that does not exist. Row-level security
  // on backup_records enforces the same rule in the database.
  if (!can(actor, "users.manage")) notFound();

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("backup_records").select("*").order("backup_created_at", { ascending: false }).limit(200);
  if (error || !data) throw new Error("ADMIN_WORKSPACE_UNAVAILABLE");
  const summary = summarizeBackups(data, new Date());
  const { latest, latestRehearsed } = summary;

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Owner only</p><h1>Backup &amp; Recovery</h1><p>What has been backed up, whether it was checked, and how a recovery is carried out. This screen reads the backup record; it cannot change, download or restore data.</p></div>
      <Link href="/">Back to overview</Link>
    </header>
    <AdminTabs current="/admin/backup" />

    {summary.freshness !== "current" && <Alert className="border-warning/40 bg-warning-soft text-warning">
      <TriangleAlertIcon />
      <AlertTitle>{summary.freshness === "none" ? "No backup has been recorded" : `The latest recorded backup is ${age(summary.ageHours!)}`}</AlertTitle>
      <AlertDescription className="text-warning">{summary.freshness === "none"
        ? "Either no backup has been taken, or it was not recorded here. Take one and record it using the steps below."
        : `A backup is expected after every trading day's close (at most ${BACKUP_OVERDUE_HOURS} hours apart). Entries made since the latest one are not protected.`}</AlertDescription>
    </Alert>}

    <section aria-label="Backup status" className="grid gap-4 md:grid-cols-3">
      <Card size="sm">
        <CardHeader><CardDescription>Latest backup</CardDescription><CardTitle className="text-lg">{latest ? qatarTime(latest.createdAt) : "None recorded"}</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5 text-muted-foreground">
          {latest ? <>
            <Badge className={summary.freshness === "current" ? tone.good : tone.warn}>{summary.freshness === "current" ? "Current" : "Overdue"}</Badge>
            <span>{age(summary.ageHours!)} · {latest.environment} · {formatBytes(latest.dumpBytes)} · {latest.receiptCount} receipt file{latest.receiptCount === 1 ? "" : "s"}</span>
          </> : <span>Times are shown in Qatar time.</span>}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader><CardDescription>File integrity</CardDescription><CardTitle className="text-lg">{latest ? "SHA-256 verified" : "Nothing to verify"}</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5 text-muted-foreground">
          {latest ? <>
            <Badge className={tone.good}>Hashes matched</Badge>
            <span>Every dump and receipt file matched its recorded hash when checked on {qatarTime(latest.integrityCheckedAt)}.</span>
          </> : <span>Hashes are checked each time a backup is recorded.</span>}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader><CardDescription>Restore rehearsal</CardDescription><CardTitle className="text-lg">{latestRehearsed ? qatarTime(latestRehearsed.rehearsal!.at) : "Never rehearsed"}</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5 text-muted-foreground">
          {latestRehearsed ? <>
            <Badge className={tone.good}>Restore verified</Badge>
            <span>The backup of {qatarTime(latestRehearsed.createdAt)} was restored into a disposable database and reconciled to the last row.</span>
          </> : <>
            <Badge className={tone.warn}>Unproven</Badge>
            <span>A backup that has never been restored is not yet proven. Rehearse one at least monthly and before every release.</span>
          </>}
        </CardContent>
      </Card>
    </section>

    <section className={styles.panel} aria-labelledby="backup-history-heading">
      <h2 id="backup-history-heading">Backup history</h2>
      {summary.entries.length === 0 ? <p className={styles.empty}>No backup has been recorded.</p> : <div className={styles.tableWrap}><Table>
        <TableHeader><TableRow>
          <TableHead scope="col">Taken (Qatar time)</TableHead><TableHead scope="col">Environment</TableHead><TableHead scope="col" className="text-right">Size</TableHead>
          <TableHead scope="col" className="text-right">Receipts</TableHead><TableHead scope="col">Integrity</TableHead><TableHead scope="col">Restore rehearsal</TableHead><TableHead scope="col">Manifest SHA-256</TableHead>
        </TableRow></TableHeader>
        <TableBody>{summary.entries.map((entry) => <TableRow key={entry.manifestSha256} data-backup={entry.manifestSha256}>
          <TableCell className="font-medium">{qatarTime(entry.createdAt)}</TableCell>
          <TableCell>{entry.environment}{entry.appVersion ? ` · v${entry.appVersion}` : ""}</TableCell>
          <TableCell className="text-right tabular-nums">{formatBytes(entry.dumpBytes)}</TableCell>
          <TableCell className="text-right tabular-nums">{entry.receiptCount}</TableCell>
          <TableCell><Badge className={tone.good}>Hashes matched</Badge></TableCell>
          <TableCell><Rehearsal entry={entry} />{entry.rehearsal && <span className="ml-2 text-muted-foreground">{qatarTime(entry.rehearsal.at)}</span>}</TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground" title={entry.manifestSha256}>{entry.manifestSha256.slice(0, 16)}…</TableCell>
        </TableRow>)}</TableBody>
      </Table></div>}
      <p className={styles.muted}>Only backups the operator has recorded appear here. The backup folders themselves are kept off this system, by design.</p>
    </section>

    <section className={styles.panel} aria-labelledby="backup-take-heading">
      <h2 id="backup-take-heading">Taking and keeping a backup</h2>
      <p className={styles.muted}>Backups are created and held outside this application, by the person who operates ShopKhata, on a trusted computer. Creating or downloading one from this screen is intentionally not offered: it would need the database password and the service key inside the web application, and a backup stored in the same account as the data it protects is not a safe backup.</p>
      <ol className="grid gap-2 pl-5 text-sm">
        <li>After the daily close, run <Code>pnpm backup:db</Code> with the operator variables set for that session.</li>
        <li>Copy the whole backup folder to storage outside the database and hosting accounts.</li>
        <li>Run <Code>pnpm backup:record --from &lt;backup folder&gt;</Code>. It re-checks every file hash, then lists the backup here.</li>
        <li>At least monthly, run <Code>pnpm backup:verify --from &lt;backup folder&gt;</Code> and record the backup again to show the rehearsal result.</li>
      </ol>
    </section>

    <section className={styles.panel} aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recovery workflow</h2>
      <Alert variant="destructive" className="border-destructive/50 bg-danger-soft">
        <ShieldAlertIcon />
        <AlertTitle>Restoring production is not available from the browser</AlertTitle>
        <AlertDescription>A restore replaces every invoice, payment and account. It is a controlled procedure carried out by the operator from the runbook, with the owner&apos;s authorization, into a new database, never a button on this page.</AlertDescription>
      </Alert>
      <ol className="grid gap-2 pl-5 text-sm">
        <li><strong>Stop new entries.</strong> Nobody keeps writing to a damaged database.</li>
        <li><strong>The owner authorizes the restore and names the backup.</strong> {latestRehearsed
          ? <>The newest backup with a verified rehearsal is {qatarTime(latestRehearsed.createdAt)} (manifest <Code>{latestRehearsed.manifestSha256.slice(0, 16)}</Code>).</>
          : <>No recorded backup has a verified rehearsal yet.</>}</li>
        <li><strong>Verify integrity and rehearse.</strong> <Code>pnpm backup:verify --from &lt;backup folder&gt;</Code> must end with RESTORE VERIFIED.</li>
        <li><strong>Restore into a new database project,</strong> not over the damaged one, following the runbook step by step. The receipt-file step requires the target host to be typed again as confirmation.</li>
        <li><strong>Validate before anyone signs in:</strong> the restored totals must equal the manifest for every shop.</li>
        <li><strong>Point the application at the restored project,</strong> re-enter what was saved after the backup, then take and record a fresh backup.</li>
      </ol>
      <p className={styles.muted}>Everything saved after the chosen backup is lost and must be re-entered from paper records. The full procedure is in the operations runbook: <Code>docs/operations/backup-restore.md</Code>. Keep a printed copy.</p>
    </section>
  </main>;
}
