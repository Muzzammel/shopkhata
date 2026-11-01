import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { ExpenseCategoryBadge, ExpenseFlags } from "@/components/expenses/expense-badges";
import { ExpenseReceipt } from "@/components/expenses/expense-receipt";
import { InvoiceTimeline } from "@/components/sales/invoice-timeline";
import { Skeleton } from "@/components/ui/skeleton";
import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { groupedQar, qar } from "@/lib/dashboard-view";
import { first } from "@/lib/date-range";
import { buildExpenseTimeline, expenseFlags } from "@/lib/expense-view";
import { readAllPages } from "@/lib/read-all-pages";
import { getReadableShops, shopViewer } from "@/lib/shop-switching";
import { longDate, personLabel, qatarDateTime } from "@/lib/sales-view";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ExpenseApprovals, ExpenseCorrectionPanel, type CorrectionView } from "../expense-forms";

export default async function ExpenseDetailPage({ params, searchParams }: PageProps<"/expenses/[expenseId]">) {
  const [{ expenseId }, query] = await Promise.all([params, searchParams]);
  const actor = await getCurrentActor();
  const shopId = first(query.shop) ?? actor.shopIds[0];
  if (!shopId || !can(actor, "records.view_assigned", shopId)) notFound();
  // Decided before anything streams, so an expense outside the actor's shops is still a real 404.
  const supabase = await createServerSupabaseClient();
  // An inactive shop opens read-only, and only for an owner; anyone else gets a 404 as for any other unreadable shop.
  const { data: shopRow } = await supabase.from("shops").select("id,name,is_active").eq("id", shopId).maybeSingle();
  const shop = shopRow ? getReadableShops(actor, [shopRow])[0] : undefined;
  if (!shop) notFound();
  const { data: exists, error } = await supabase.from("effective_expenses").select("id").eq("shop_id", shopId).eq("id", expenseId).maybeSingle();
  if (error || !exists) notFound();

  return <main className="mx-auto grid w-full max-w-[1100px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <Link href={`/expenses?shop=${shopId}`} className="inline-flex min-h-9 items-center gap-1.5 justify-self-start rounded-full px-1 text-[13px] font-semibold text-muted-foreground no-underline hover:text-foreground"><ArrowLeftIcon aria-hidden className="size-4" />Expenses</Link>
    <Suspense fallback={<div aria-busy="true" aria-label="Loading expense" className="grid gap-4 sm:gap-5"><Skeleton className="h-48 rounded-3xl" /><div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]"><Skeleton className="h-64 rounded-3xl" /><Skeleton className="h-40 rounded-3xl" /></div><Skeleton className="h-14 rounded-3xl" /></div>}>
      <ExpenseDetailBody actor={shopViewer(actor, shop)} shopId={shopId} expenseId={expenseId} />
    </Suspense>
  </main>;
}

async function ExpenseDetailBody({ actor, shopId, expenseId }: { actor: Actor; shopId: string; expenseId: string }) {
  const supabase = await createServerSupabaseClient();
  const [shopResult, currentResult, originalResult, requestsResult, decisionsResult, attachmentsResult] = await Promise.all([
    supabase.from("shops").select("name").eq("id", shopId).maybeSingle(),
    supabase.from("effective_expenses").select("id,business_date,recorded_at,created_by,category,description,amount_dirham,correction_request_id,backdated_reason").eq("shop_id", shopId).eq("id", expenseId).maybeSingle(),
    supabase.from("expenses").select("amount_dirham,category,description").eq("shop_id", shopId).eq("id", expenseId).maybeSingle(),
    readAllPages((o, e) => supabase.from("expense_correction_requests").select("id,amount_dirham,category,description,reason,requested_by,requested_at,expected_correction_request_id").eq("shop_id", shopId).eq("expense_id", expenseId).order("requested_at").range(o, e)),
    readAllPages((o, e) => supabase.from("expense_correction_decisions").select("request_id,decision,reason,decided_by,decided_at").eq("shop_id", shopId).eq("expense_id", expenseId).order("decided_at").range(o, e)),
    readAllPages((o, e) => supabase.from("attachments").select("id,file_path,file_name,content_type,byte_size,created_at,created_by").eq("shop_id", shopId).eq("expense_id", expenseId).order("created_at").range(o, e)),
  ]);
  const current = currentResult.data, original = originalResult.data;
  if (shopResult.error || currentResult.error || originalResult.error || requestsResult.error || decisionsResult.error || attachmentsResult.error || !current || !original || !requestsResult.data || !decisionsResult.data || !attachmentsResult.data) throw new Error("EXPENSE_DETAIL_UNAVAILABLE");
  const requests = requestsResult.data, decisions = decisionsResult.data, files = attachmentsResult.data;

  // Private bucket: short-lived signed links, as before. A failed signing shows the file as unavailable.
  const paths = files.map((file) => file.file_path);
  const [opened, downloaded] = paths.length ? await Promise.all([
    supabase.storage.from("expense-receipts").createSignedUrls(paths, 300),
    supabase.storage.from("expense-receipts").createSignedUrls(paths, 300, { download: true }),
  ]) : [{ data: [] }, { data: [] }];

  // Names label the history only; staff can read just their own profile, so others fall back to an id tail.
  const actorIds = [...new Set([current.created_by, ...requests.map((r) => r.requested_by), ...decisions.map((d) => d.decided_by), ...files.map((f) => f.created_by)].filter((id): id is string => Boolean(id)))];
  const { data: profiles } = actorIds.length ? await supabase.from("profiles").select("id,display_name").in("id", actorIds) : { data: [] };
  const people: Record<string, string> = Object.fromEntries((profiles ?? []).filter((p) => p.display_name).map((p) => [p.id, p.display_name!]));
  const person = (id: string | null) => personLabel(people, id);

  const decided = new Set(decisions.map((decision) => decision.request_id));
  const pending: CorrectionView[] = requests.filter((request) => !decided.has(request.id)).map((request) => ({
    id: request.id, amountDirham: request.amount_dirham, category: request.category, description: request.description, reason: request.reason,
    requestedBy: request.requested_by, requestedAt: request.requested_at, stale: request.expected_correction_request_id !== current.correction_request_id,
  }));
  const expense = { id: expenseId, amountDirham: current.amount_dirham!, category: current.category!, description: current.description! };
  const corrected = current.correction_request_id !== null;
  const flags = expenseFlags({ pendingCount: pending.length, corrected, backdated: Boolean(current.backdated_reason) });
  const events = buildExpenseTimeline({
    original: { amountDirham: original.amount_dirham, category: original.category, description: original.description, recordedAt: current.recorded_at!, createdBy: current.created_by, businessDate: current.business_date!, backdatedReason: current.backdated_reason },
    receipts: files.map((file) => ({ id: file.id, fileName: file.file_name, createdAt: file.created_at, createdBy: file.created_by })),
    requests: requests.map((r) => ({ id: r.id, amountDirham: r.amount_dirham, category: r.category, description: r.description, reason: r.reason, requestedBy: r.requested_by, requestedAt: r.requested_at, expectedRequestId: r.expected_correction_request_id })),
    decisions: decisions.map((d) => ({ requestId: d.request_id, decision: d.decision, reason: d.reason, decidedBy: d.decided_by, decidedAt: d.decided_at })),
  }, person);
  const canRequest = can(actor, "expense.create", shopId);

  return <>
    <header className="grid gap-5 rounded-3xl border border-border bg-card p-5 sk-enter sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="grid min-w-0 flex-[1_1_20rem] gap-2">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Expense · {shopResult.data?.name ?? "Shop"}</p>
          <h1 data-slot="heading" className="text-2xl font-semibold tracking-tight whitespace-pre-line [overflow-wrap:anywhere] sm:text-3xl">{expense.description}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ExpenseCategoryBadge category={expense.category} />
            <ExpenseFlags flags={flags} />
          </div>
        </div>
        <div className="grid justify-items-end gap-0.5 text-right tabular-nums max-sm:w-full max-sm:justify-items-start max-sm:text-left">
          <span className="text-xs text-muted-foreground">Amount</span>
          <strong data-slot="amount" className="text-4xl font-semibold tracking-tight sm:text-5xl"><span className="text-base font-medium text-muted-foreground">QAR</span> {groupedQar(expense.amountDirham)}</strong>
          {corrected && original.amount_dirham !== expense.amountDirham && <span className="text-xs text-muted-foreground">Originally recorded as {qar(original.amount_dirham)}</span>}
          <span className="text-xs text-muted-foreground">Business date {longDate(current.business_date!)}</span>
        </div>
      </div>
      {canRequest && <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <ExpenseCorrectionPanel shopId={shopId} expense={expense} pendingCount={pending.length} />
      </div>}
    </header>

    {pending.length > 0 && <ExpenseApprovals shopId={shopId} expense={expense} requests={pending} people={people} canApprove={can(actor, "correction.approve", shopId)} />}

    <div className="grid items-start gap-4 sm:gap-5 md:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-labelledby="details-heading" className="grid gap-3 rounded-3xl border border-border bg-card p-5 sm:p-6">
        <h2 id="details-heading" data-slot="heading" className="text-base font-semibold">Details</h2>
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-6 text-sm [&>dd]:border-b [&>dd]:border-border [&>dd]:py-2.5 [&>dt]:border-b [&>dt]:border-border [&>dt]:py-2.5 [&>dt]:text-muted-foreground max-[420px]:grid-cols-1 max-[420px]:[&>dt]:border-0 max-[420px]:[&>dt]:pb-0">
          <dt>Amount</dt><dd className="font-semibold tabular-nums">{qar(expense.amountDirham)}</dd>
          <dt>Category</dt><dd><ExpenseCategoryBadge category={expense.category} /></dd>
          <dt>Business date</dt><dd>{longDate(current.business_date!)}</dd>
          {current.backdated_reason && <><dt>Backdate reason</dt><dd className="[overflow-wrap:anywhere]">{current.backdated_reason}</dd></>}
          <dt>Recorded</dt><dd>{qatarDateTime(current.recorded_at!)}</dd>
          <dt>Recorded by</dt><dd>{person(current.created_by)}</dd>
          <dt>Shop</dt><dd>{shopResult.data?.name ?? "—"}</dd>
          <dt>Description</dt><dd className="whitespace-pre-line [overflow-wrap:anywhere]">{expense.description}</dd>
          <dt>Status</dt><dd>{corrected ? "Corrected · showing the latest approved values" : "As recorded"}{pending.length > 0 && ` · ${pending.length} request${pending.length === 1 ? "" : "s"} pending approval`}</dd>
          <dt>Reference</dt><dd className="font-mono text-xs break-all text-muted-foreground">{expenseId}</dd>
        </dl>
      </section>
      <ExpenseReceipt files={files.map((file, index) => ({ id: file.id, name: file.file_name, contentType: file.content_type, byteSize: file.byte_size, createdAt: file.created_at, openUrl: opened.data?.[index]?.signedUrl ?? null, downloadUrl: downloaded.data?.[index]?.signedUrl ?? null }))} />
    </div>

    <InvoiceTimeline events={events} open />
  </>;
}
