"use client";

import { useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlertIcon, PencilLineIcon, SlidersHorizontalIcon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";

import { CustomerAvatar } from "@/components/customers/customer-status";
import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { registerAccountInput } from "@/lib/account-admin";
import { accessSummary, accountChanges, ROLE_LABEL, ROLE_SUMMARY, type AccountRole } from "@/lib/account-view";
import { cn } from "@/lib/utils";

import { Comparison } from "../invoice-operations";
import { registerAccount, setShopAssignment, updateAccount, type AccountAdminResult } from "./actions";

type Shop = { id: string; name: string };
export type AccountRow = { id: string; email: string; displayName: string; role: string; isActive: boolean; shopIds: string[] };
const ROLES: AccountRole[] = ["staff", "manager", "owner"];
const UNCONFIRMED = "The change was not saved. Refresh to see the current accounts.";

const { badge } = ui;
const ROLE_TONE: Record<string, string> = { owner: "bg-primary text-primary-foreground", manager: "bg-yellow-soft text-foreground ring-1 ring-yellow/60 ring-inset", staff: "bg-muted text-muted-foreground" };

export function RoleBadge({ role }: { role: string }) {
  return <span data-role={role} className={cn(badge, ROLE_TONE[role] ?? ROLE_TONE.staff)}>{role}</span>;
}

/** Active, deactivated, and the one state the data shows that needs the owner: active but no shop to work in. */
export function StatusBadges({ account }: { account: Pick<AccountRow, "role" | "isActive" | "shopIds"> }) {
  return <span className="inline-flex flex-wrap gap-1">
    <span data-status={account.isActive ? "active" : "deactivated"} className={cn(badge, account.isActive ? "bg-success-soft text-success" : "bg-card text-muted-foreground ring-1 ring-border ring-inset")}>{account.isActive ? "Active" : "Deactivated"}</span>
    {account.isActive && account.role !== "owner" && account.shopIds.length === 0 && <span data-status="no-shop" className={cn(badge, "bg-warning-soft text-warning")}>No shop access</span>}
  </span>;
}

export function Failure({ title, message }: { title: string; message: string }) {
  return <Alert variant="destructive" className="border-destructive/40 bg-danger-soft"><CircleAlertIcon /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

/** Role as three choices, each saying what it allows, so the choice is never made from a bare word. */
function RolePicker({ value, onChange, name }: { value: string; onChange: (role: AccountRole) => void; name: string }) {
  return <fieldset className="grid gap-2">
    <legend data-slot="legend" className={cn(ui.label, "mb-1.5")}>Role</legend>
    {ROLES.map((role) => <label key={role} data-slot="label" className="grid cursor-pointer gap-0.5 rounded-2xl border border-input bg-card px-4 py-3 transition-colors duration-150 hover:bg-muted has-[:checked]:border-foreground has-[:checked]:ring-1 has-[:checked]:ring-foreground has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40">
      <span className="flex items-center gap-2.5 text-sm font-semibold">
        <input data-slot="radio" type="radio" name={name} value={role} checked={value === role} onChange={() => onChange(role)} aria-label={ROLE_LABEL[role]} aria-describedby={`${name}-${role}-summary`} className="size-4 accent-foreground" />
        {ROLE_LABEL[role]}
      </span>
      <span id={`${name}-${role}-summary`} className="pl-6.5 text-xs text-muted-foreground">{ROLE_SUMMARY[role]}</span>
    </label>)}
  </fieldset>;
}

const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;

/**
 * The account directory: a table on wide screens, one card per account below lg. "Manage" opens the
 * drawer that edits role, status and shop access through the unchanged admin actions.
 */
export function AccountDirectory({ accounts, shops, actorId }: { accounts: AccountRow[]; shops: Shop[]; actorId: string }) {
  // Each opening starts from the account as last read, so a refreshed row is never edited from stale values.
  const [editing, setEditing] = useState<{ id: string; session: number } | null>(null);
  const [open, setOpen] = useState(false);
  const managed = accounts.find((item) => item.id === editing?.id);
  return <>
    <section aria-label="Account directory" className="rounded-3xl border-border lg:border lg:bg-card">
      <table data-slot="account-table" className="w-full border-separate border-spacing-0 max-lg:block">
        <caption className="sr-only">What each account can reach right now</caption>
        <thead data-slot="head" className="max-lg:sr-only">
          <tr data-slot="row"><Th className="rounded-tl-3xl">Account</Th><Th>Role</Th><Th>Status</Th><Th>Shop access</Th><Th className="rounded-tr-3xl text-right"><span className="sr-only">Actions</span></Th></tr>
        </thead>
        <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">
          {accounts.map((account) => {
            const self = account.id === actorId;
            return <tr key={account.id} data-slot="row" data-account={account.email} className="transition-colors duration-150 hover:bg-muted/60 max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-3 max-lg:gap-y-2.5 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
              <Td className="max-lg:col-start-1 max-lg:row-start-1">
                <span className="flex min-w-0 items-center gap-3">
                  <CustomerAvatar name={account.displayName} className={cn(!account.isActive && "opacity-50")} />
                  <span className="grid min-w-0">
                    <strong className="truncate text-[15px] font-semibold lg:text-sm">{account.displayName}{self && <span className="font-normal text-muted-foreground"> (you)</span>}</strong>
                    <span className="truncate text-xs text-muted-foreground [overflow-wrap:anywhere]">{account.email}</span>
                  </span>
                </span>
              </Td>
              <Td className="max-lg:col-start-2 max-lg:row-start-1 max-lg:self-start"><RoleBadge role={account.role} /></Td>
              <Td className="max-lg:col-span-2 max-lg:row-start-2"><StatusBadges account={account} /></Td>
              <Td className="text-sm max-lg:col-span-2 max-lg:row-start-3">
                <span className="text-xs text-muted-foreground lg:hidden">Shop access: </span>
                <span className={cn(!account.isActive && "text-muted-foreground")}>{accessSummary(account, shops)}</span>
              </Td>
              <Td className="text-right max-lg:col-span-2 max-lg:row-start-4 max-lg:text-left">
                {self
                  ? <span className="text-xs text-muted-foreground">Another owner changes your account</span>
                  : <button data-slot="button" type="button" aria-label={`Manage ${account.displayName}`} className={cn(ui.secondary, "min-h-9 px-3.5 max-lg:w-full max-sm:min-h-11")} onClick={() => { setEditing({ id: account.id, session: (editing?.session ?? 0) + 1 }); setOpen(true); }}><SlidersHorizontalIcon aria-hidden />Manage</button>}
              </Td>
            </tr>;
          })}
        </tbody>
      </table>
    </section>
    {editing && managed && <ManageAccountDrawer key={editing.session} account={managed} shops={shops} open={open} onOpenChange={setOpen} />}
  </>;
}

/** Role, status and shop access for one account, then a review of current against new before anything is saved. */
function ManageAccountDrawer({ account, shops, open, onOpenChange }: { account: AccountRow; shops: Shop[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [role, setRole] = useState(account.role);
  const [isActive, setIsActive] = useState(account.isActive);
  const [shopIds, setShopIds] = useState(account.shopIds);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const after = { role, isActive, shopIds };
  const { rows, notes, changed } = accountChanges(account.displayName, account, after, shops);

  function toReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) { setMessage("Nothing differs from the current account yet."); return; }
    setMessage(""); setReview(true);
  }

  // The same calls, in the same order, as before the redesign: role and status first, then each shop that differs.
  async function save() {
    if (busy) return;
    setBusy(true); setMessage("");
    let result: AccountAdminResult = { ok: true };
    try {
      result = await updateAccount({ user_id: account.id, role, is_active: isActive });
      for (const shop of shops) {
        if (!result.ok) break;
        const assigned = shopIds.includes(shop.id);
        if (assigned === account.shopIds.includes(shop.id)) continue;
        result = await setShopAssignment({ user_id: account.id, shop_id: shop.id, assigned });
      }
    } catch {
      result = { ok: false, message: UNCONFIRMED };
    }
    setBusy(false);
    router.refresh();
    if (result.ok) { toast.success(`${account.displayName} updated.`); onOpenChange(false); }
    else setMessage(result.message);
  }

  return <Drawer open={open} onOpenChange={(next) => { if (next || !busy) onOpenChange(next); }} title={`Manage ${account.displayName}`} description={<>{account.email} · Changes apply to this account&apos;s next action and are recorded in the account history.</>}>
    {!review ? <form noValidate aria-label={`Manage ${account.displayName}`} className="grid gap-5" onSubmit={toReview}>
      <RolePicker name="role" value={role} onChange={(value) => { setRole(value); setMessage(""); }} />
      <fieldset className="grid gap-2">
        <legend data-slot="legend" className={cn(ui.label, "mb-1.5")}>Status</legend>
        <label data-slot="label" className="flex cursor-pointer items-start gap-3 rounded-2xl border border-input bg-card px-4 py-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40">
          <input data-slot="checkbox" type="checkbox" name="is_active" checked={isActive} onChange={(event) => { setIsActive(event.target.checked); setMessage(""); }} className="mt-0.5 size-4 shrink-0 accent-foreground" />
          <span className="grid gap-0.5"><span className="font-semibold">Account is active</span><span className="text-xs text-muted-foreground">Untick to deactivate. A deactivated account can sign in but can do nothing; its history stays.</span></span>
        </label>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend data-slot="legend" className={cn(ui.label, "mb-1.5")}>Shop access</legend>
        {role === "owner" && <p className="text-xs text-muted-foreground">An owner can always use every shop. Ticks are kept for if the role changes later.</p>}
        <div className="flex flex-wrap gap-2">{shops.map((shop) => <label key={shop.id} data-slot="label" className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-input bg-card px-3.5 text-sm font-medium hover:bg-muted has-[:checked]:border-foreground has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40 max-sm:min-h-11">
          <input data-slot="checkbox" type="checkbox" name={`shop-${shop.id}`} checked={shopIds.includes(shop.id)} onChange={(event) => { const on = event.target.checked; setShopIds((current) => on ? [...current, shop.id] : current.filter((id) => id !== shop.id)); setMessage(""); }} className="size-4 accent-current" />
          {shop.name}
        </label>)}</div>
      </fieldset>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      <button data-slot="button" className={ui.primary}>Review changes</button>
    </form> : <div className="grid gap-5">
      <section aria-labelledby="account-review-heading" className="grid gap-3">
        <h3 id="account-review-heading" data-slot="heading" className="text-sm font-semibold">Review before saving</h3>
        <Comparison label="Requested account change" rows={rows} />
        {notes.length > 0 && <ul aria-label="What this change does" className="grid list-none gap-2 pl-0">{notes.map((note) => <li key={note} className={ui.warn}>{note}</li>)}</ul>}
      </section>
      {busy && <p role="status" className="text-sm font-medium">Saving…</p>}
      {message && <Failure title="The change was not saved" message={message} />}
      <div className="flex flex-wrap gap-2">
        <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save account"}</button>
        <button data-slot="button" type="button" className={ui.secondary} disabled={busy} onClick={() => { setReview(false); setMessage(""); }}><PencilLineIcon aria-hidden />Edit</button>
      </div>
    </div>}
  </Drawer>;
}

export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="grid content-start gap-1.5">
    <label data-slot="label" htmlFor={id} className={ui.label}>{label}</label>
    {children}
    {hint && !error && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    {error && <p id={`${id}-error`} data-slot="field-error" className={ui.fieldError}>{error}</p>}
  </div>;
}

/** Gives an existing sign-in a ShopKhata role. The sign-in itself is created in the Supabase dashboard. */
export function RegisterAccountDrawer({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(""); const [displayName, setDisplayName] = useState(""); const [role, setRole] = useState<AccountRole>("staff");
  const [checked, setChecked] = useState(false); const [review, setReview] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");

  const parsed = registerAccountInput.safeParse({ email, display_name: displayName, role });
  const issue = (field: string) => parsed.success ? undefined : parsed.error.issues.find((item) => item.path[0] === field);
  const errors = {
    email: issue("email") ? "Enter the sign-in email address." : undefined,
    name: issue("display_name") ? "Enter the name people will see." : undefined,
  };

  function toReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setChecked(true);
    if (errors.email || errors.name) { document.getElementById(errors.email ? "register-email" : "register-name")?.focus(); return; }
    setMessage(""); setReview(true);
  }

  async function register() {
    if (busy) return;
    setBusy(true); setMessage("");
    let result: AccountAdminResult;
    try { result = await registerAccount({ email, display_name: displayName, role }); } catch { result = { ok: false, message: UNCONFIRMED }; }
    setBusy(false);
    router.refresh();
    if (result.ok) {
      toast.success(`${displayName.trim()} registered. Assign a shop with Manage.`);
      setEmail(""); setDisplayName(""); setRole("staff"); setChecked(false); setReview(false); setOpen(false);
    } else { setMessage(result.message); setReview(false); }
  }

  return <>
    <button data-slot="button" type="button" className={cn(ui.primary, className)} onClick={() => setOpen(true)}><UserPlusIcon aria-hidden />Register account</button>
    <Drawer open={open} onOpenChange={(next) => { if (next || !busy) setOpen(next); }} title="Register an account" description={<>Gives an existing sign-in a ShopKhata role. Create the sign-in (email and password) in the Supabase dashboard under Authentication first.</>}>
      {!review ? <form noValidate aria-label="Account details" className="grid gap-5" onSubmit={toReview}>
        <Field id="register-email" label="Sign-in email" error={checked ? errors.email : undefined} hint="The email the person signs in with.">
          <input data-slot="input" id="register-email" type="email" maxLength={320} autoComplete="off" value={email} aria-invalid={Boolean(checked && errors.email) || undefined} aria-describedby={checked && errors.email ? "register-email-error" : "register-email-hint"} onChange={(event) => { setEmail(event.target.value); setMessage(""); }} className={ui.field} />
        </Field>
        <Field id="register-name" label="Display name" error={checked ? errors.name : undefined}>
          <input data-slot="input" id="register-name" maxLength={200} autoComplete="off" value={displayName} aria-invalid={Boolean(checked && errors.name) || undefined} aria-describedby={checked && errors.name ? "register-name-error" : undefined} onChange={(event) => { setDisplayName(event.target.value); setMessage(""); }} className={ui.field} />
        </Field>
        <RolePicker name="register-role" value={role} onChange={setRole} />
        {message && <Failure title="The account was not registered" message={message} />}
        <button data-slot="button" className={ui.primary}>Review account</button>
      </form> : <div className="grid gap-5">
        <section aria-labelledby="register-review-heading" className="grid gap-3 rounded-2xl border border-border p-4">
          <h3 id="register-review-heading" data-slot="heading" className="text-sm font-semibold">Review before registering</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Sign-in email</dt><dd className="[overflow-wrap:anywhere]">{email.trim().toLowerCase()}</dd>
            <dt className="text-muted-foreground">Display name</dt><dd className="[overflow-wrap:anywhere]">{displayName.trim()}</dd>
            <dt className="text-muted-foreground">Role</dt><dd>{ROLE_LABEL[role]}</dd>
            <dt className="text-muted-foreground">Status</dt><dd>Active</dd>
          </dl>
        </section>
        <p className={ui.warn}>{role === "owner" ? "An owner can use every shop, manage accounts and see backups straight away." : "The account starts with no shop access. Use Manage to assign a shop after registering."}</p>
        {busy && <p role="status" className="text-sm font-medium">Registering…</p>}
        <div className="flex flex-wrap gap-2">
          <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} disabled={busy} onClick={() => void register()}>{busy ? "Registering…" : "Register account"}</button>
          <button data-slot="button" type="button" className={ui.secondary} disabled={busy} onClick={() => setReview(false)}><PencilLineIcon aria-hidden />Edit</button>
        </div>
      </div>}
    </Drawer>
  </>;
}
