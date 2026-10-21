"use client";

import { useState, type ComponentProps, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PencilLineIcon, PlusIcon, SlidersHorizontalIcon, StoreIcon } from "lucide-react";
import { toast } from "sonner";

import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { createShopInput, isDuplicateShopName, SHOP_NAME_MAX, updateShopInput } from "@/lib/shop-admin";
import { cn } from "@/lib/utils";

import { Comparison } from "../../invoice-operations";
import { Failure, Field } from "../account-forms";
import { createShop, updateShop, type ShopAdminResult } from "../shop-actions";

export type ShopRow = { id: string; name: string; isActive: boolean; assignedNames: string[] };
const UNCONFIRMED = "The change was not saved. Refresh to see the current shops.";
const { badge } = ui;

const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;

const accessLabel = (shop: ShopRow) => shop.assignedNames.length === 1 ? "1 account assigned" : `${shop.assignedNames.length} accounts assigned`;

/**
 * The shop directory: a table on wide screens, one card per shop below lg. "Manage" opens the
 * rename drawer. Only what the data supports is shown: name, active state and assigned accounts.
 */
export function ShopDirectory({ shops }: { shops: ShopRow[] }) {
  // Each opening starts from the shop as last read, so a refreshed row is never edited from stale values.
  const [editing, setEditing] = useState<{ id: string; session: number } | null>(null);
  const [open, setOpen] = useState(false);
  const managed = shops.find((item) => item.id === editing?.id);
  return <>
    <section aria-label="Shop directory" className="rounded-3xl border-border lg:border lg:bg-card">
      <table data-slot="shop-table" className="w-full border-separate border-spacing-0 max-lg:block">
        <caption className="sr-only">Every shop and how many accounts are assigned to it</caption>
        <thead data-slot="head" className="max-lg:sr-only">
          <tr data-slot="row"><Th className="rounded-tl-3xl">Shop</Th><Th>Status</Th><Th>Access</Th><Th className="rounded-tr-3xl text-right"><span className="sr-only">Actions</span></Th></tr>
        </thead>
        <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">
          {shops.map((shop) => <tr key={shop.id} data-slot="row" data-shop={shop.name} className="transition-colors duration-150 hover:bg-muted/60 max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-3 max-lg:gap-y-2.5 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
            <Td className="max-lg:col-start-1 max-lg:row-start-1">
              <span className="flex min-w-0 items-center gap-3">
                <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><StoreIcon className="size-4" /></span>
                <strong className="truncate text-[15px] font-semibold lg:text-sm">{shop.name}</strong>
              </span>
            </Td>
            <Td className="max-lg:col-start-2 max-lg:row-start-1 max-lg:self-start">
              <span data-status={shop.isActive ? "active" : "inactive"} className={cn(badge, shop.isActive ? "bg-success-soft text-success" : "bg-card text-muted-foreground ring-1 ring-border ring-inset")}>{shop.isActive ? "Active" : "Inactive"}</span>
            </Td>
            <Td className="text-sm max-lg:col-span-2 max-lg:row-start-2">
              <span className="text-xs text-muted-foreground lg:hidden">Access: </span>
              <span>All owners{shop.assignedNames.length > 0 && <> · <span data-slot="assigned-count">{accessLabel(shop)}</span></>}</span>
            </Td>
            <Td className="text-right max-lg:col-span-2 max-lg:row-start-3 max-lg:text-left">
              <button data-slot="button" type="button" aria-label={`Manage ${shop.name}`} className={cn(ui.secondary, "min-h-9 px-3.5 max-lg:w-full max-sm:min-h-11")} onClick={() => { setEditing({ id: shop.id, session: (editing?.session ?? 0) + 1 }); setOpen(true); }}><SlidersHorizontalIcon aria-hidden />Manage</button>
            </Td>
          </tr>)}
        </tbody>
      </table>
    </section>
    {editing && managed && <ShopNameDrawer key={editing.session} mode="rename" shop={managed} shops={shops} open={open} onOpenChange={setOpen} />}
  </>;
}

export function AddShopDrawer({ shops, className }: { shops: ShopRow[]; className?: string }) {
  const [open, setOpen] = useState(false);
  // A fresh form on every opening: the key changes only while closed.
  const [session, setSession] = useState(0);
  return <>
    <button data-slot="button" type="button" className={cn(ui.primary, className)} onClick={() => { setSession((n) => n + 1); setOpen(true); }}><PlusIcon aria-hidden />Add shop</button>
    {session > 0 && <ShopNameDrawer key={session} mode="create" shops={shops} open={open} onOpenChange={setOpen} />}
  </>;
}

/** Name, then a review, then one governed RPC. Create and rename differ only in the copy and the action. */
function ShopNameDrawer({ mode, shop, shops, open, onOpenChange }: { mode: "create" | "rename"; shop?: ShopRow; shops: ShopRow[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState(shop?.name ?? "");
  const [checked, setChecked] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const trimmed = name.trim();
  const creating = mode === "create";

  const issue = !trimmed ? "Enter the shop or branch name."
    : trimmed.length > SHOP_NAME_MAX ? `Use ${SHOP_NAME_MAX} characters or fewer.`
    : isDuplicateShopName(trimmed, shops, shop?.id) ? "Another shop already uses that name."
    : !creating && trimmed === shop?.name ? "Enter a different name to rename this shop."
    : undefined;

  function toReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setChecked(true);
    if (issue) { document.getElementById("shop-name")?.focus(); return; }
    setMessage(""); setReview(true);
  }

  async function save() {
    if (busy) return;
    const command = creating ? createShopInput.safeParse({ name }) : updateShopInput.safeParse({ shop_id: shop?.id, name });
    if (!command.success) { setMessage("Enter a shop name of 1 to 100 characters."); setReview(false); return; }
    setBusy(true); setMessage("");
    let result: ShopAdminResult;
    try { result = creating ? await createShop(command.data) : await updateShop(command.data); } catch { result = { ok: false, message: UNCONFIRMED }; }
    setBusy(false);
    router.refresh();
    if (result.ok) {
      toast.success(creating ? `${trimmed} created. It now appears in the shop switcher.` : `Renamed to ${trimmed}.`);
      onOpenChange(false);
    } else { setMessage(result.message); setReview(false); }
  }

  const title = creating ? "Add a shop" : `Manage ${shop?.name}`;
  return <Drawer open={open} onOpenChange={(next) => { if (next || !busy) onOpenChange(next); }} title={title}
    description={creating ? "Adds an empty shop. No sales, customers or expenses are created." : <>Rename only. <span className="[overflow-wrap:anywhere]">Shop ID {shop?.id}</span></>}>
    {!review ? <>
      <form noValidate aria-label={creating ? "Shop details" : `Rename ${shop?.name}`} className="grid gap-5" onSubmit={toReview}>
        <Field id="shop-name" label="Shop / Branch name" error={checked ? issue : undefined} hint="Shown in the shop switcher and on every report for this shop.">
          <input data-slot="input" id="shop-name" maxLength={SHOP_NAME_MAX} autoComplete="off" value={name} aria-invalid={Boolean(checked && issue) || undefined} aria-describedby={checked && issue ? "shop-name-error" : "shop-name-hint"} onChange={(event) => { setName(event.target.value); setMessage(""); }} className={ui.field} />
        </Field>
        {message && <Failure title={creating ? "The shop was not created" : "The shop was not renamed"} message={message} />}
        <button data-slot="button" className={ui.primary}>{creating ? "Review shop" : "Review rename"}</button>
      </form>
      {!creating && shop && <section aria-labelledby="shop-access-heading" className="grid gap-2 border-t border-border pt-5">
        <h3 id="shop-access-heading" data-slot="heading" className="text-sm font-semibold">Who can use this shop</h3>
        <p className="text-sm text-muted-foreground">All owners, automatically.{shop.assignedNames.length > 0 ? ` Also assigned: ${shop.assignedNames.join(", ")}.` : " No manager or staff account is assigned yet."}</p>
        <Link href="/admin" className={cn(ui.secondary, "justify-self-start")}>Change access in Accounts</Link>
      </section>}
    </> : <div className="grid gap-5">
      <section aria-labelledby="shop-review-heading" className="grid gap-3">
        <h3 id="shop-review-heading" data-slot="heading" className="text-sm font-semibold">{creating ? "Review before creating" : "Review before renaming"}</h3>
        {creating
          ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-2xl border border-border p-4 text-sm">
            <dt className="text-muted-foreground">Shop / Branch name</dt><dd className="[overflow-wrap:anywhere]">{trimmed}</dd>
            <dt className="text-muted-foreground">Owner access</dt><dd>Every owner can use it automatically</dd>
            <dt className="text-muted-foreground">Starts with</dt><dd>No sales, customers, payments or expenses</dd>
          </dl>
          : <Comparison label="Requested shop change" rows={[{ label: "Shop name", current: shop?.name ?? "", requested: trimmed }]} />}
      </section>
      <ul aria-label="What this change does" className="grid list-none gap-2 pl-0">
        {creating ? <>
          <li className={ui.warn}>{trimmed} will appear in the global shop switcher for every owner.</li>
          <li className={ui.warn}>Manager and staff access can be assigned after creation, in Accounts.</li>
        </> : <li className={ui.warn}>Historical records stay attached to the same shop ID. Only the name shown on screens, reports and prints changes.</li>}
      </ul>
      {busy && <p role="status" className="text-sm font-medium">{creating ? "Creating…" : "Saving…"}</p>}
      {message && <Failure title="The change was not saved" message={message} />}
      <div className="flex flex-wrap gap-2">
        <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} disabled={busy} onClick={() => void save()}>{busy ? (creating ? "Creating…" : "Saving…") : (creating ? "Create shop" : "Save name")}</button>
        <button data-slot="button" type="button" className={ui.secondary} disabled={busy} onClick={() => { setReview(false); setMessage(""); }}><PencilLineIcon aria-hidden />Edit</button>
      </div>
    </div>}
  </Drawer>;
}
