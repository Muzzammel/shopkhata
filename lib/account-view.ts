// Presentation helpers for Accounts. Nothing here decides access: the admin RPCs and
// lib/auth/permissions.ts do. These only put the existing rules into words.

import { effectiveAccess } from "@/lib/account-admin";

export type AccountRole = "owner" | "manager" | "staff";
export type AccountState = { role: string; isActive: boolean; shopIds: readonly string[] };
type Shop = { id: string; name: string };

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff" };
export const ROLE_SUMMARY: Record<AccountRole, string> = {
  staff: "Enters sales, payments and expenses, and requests corrections, in assigned shops.",
  manager: "Everything staff can do, plus approving corrections and replacements and closing or reopening dates, in assigned shops.",
  owner: "Every shop, every report, Accounts and Backup. Only an owner can change another account.",
};

const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;
const statusLabel = (active: boolean) => active ? "Active" : "Inactive";
const shopList = (ids: readonly string[], shops: readonly Shop[]) => {
  const names = shops.filter((shop) => ids.includes(shop.id)).map((shop) => shop.name);
  return names.length ? names.join(", ") : "None";
};

/** What the account will reach, in the same words as the directory's "Shop access" column. */
export const accessSummary = (state: AccountState, shops: readonly Shop[]) =>
  effectiveAccess({ ...state, shopNames: shops.filter((shop) => state.shopIds.includes(shop.id)).map((shop) => shop.name) });

/** Current against requested values, and what the change means, for the review step before saving. */
export function accountChanges(name: string, before: AccountState, after: AccountState, shops: readonly Shop[]) {
  const added = shops.filter((shop) => after.shopIds.includes(shop.id) && !before.shopIds.includes(shop.id));
  const removed = shops.filter((shop) => before.shopIds.includes(shop.id) && !after.shopIds.includes(shop.id));
  const changed = before.role !== after.role || before.isActive !== after.isActive || added.length > 0 || removed.length > 0;
  const rows = [
    { label: "Role", current: roleLabel(before.role), requested: roleLabel(after.role) },
    { label: "Status", current: statusLabel(before.isActive), requested: statusLabel(after.isActive) },
    { label: "Assigned shops", current: shopList(before.shopIds, shops), requested: shopList(after.shopIds, shops) },
    { label: "Can reach", current: accessSummary(before, shops), requested: accessSummary(after, shops) },
  ];

  const notes: string[] = [];
  if (before.isActive && !after.isActive) notes.push(`${name} loses all access at their next page load. Their past records and history stay.`);
  if (!before.isActive && after.isActive) notes.push(`${name} can sign in and work again.`);
  if (before.role !== after.role) {
    if (after.role === "owner") notes.push(`As an owner, ${name} can use every shop, manage accounts and see backups.`);
    else if (before.role === "owner") notes.push(`${name} loses Accounts, Backup and every shop that is not assigned.`);
    if (after.role === "manager") notes.push(`As a manager, ${name} can approve corrections and replacements and close or reopen dates in assigned shops.`);
    if (before.role === "manager" && after.role === "staff") notes.push(`${name} can no longer approve corrections or close and reopen dates.`);
  }
  if (after.role !== "owner") {
    for (const shop of added) notes.push(`${name} gains access to ${shop.name} at their next page load.`);
    for (const shop of removed) notes.push(`${name} loses access to ${shop.name} at their next page load.`);
    if (after.isActive && after.shopIds.length === 0) notes.push(`${name} will have no shop access and will see "No shop assigned".`);
  } else if (added.length || removed.length) {
    notes.push("Shop assignments are saved, but an owner can use every shop regardless.");
  }
  return { rows, notes, changed };
}

export type AuditEvent = { action: string; entity_id: string | null; shop_id: string | null; metadata: unknown; reason?: string | null };

const ACTIONS: Record<string, string> = {
  "account.register": "Registered account", "account.update": "Changed role or status",
  "account.deactivate": "Deactivated account", "account.reactivate": "Reactivated account",
  "assignment.add": "Added shop access", "assignment.remove": "Removed shop access",
};

/** One line per audit event: a title, and for role/status changes the before → after values in words. */
export function describeAccountEvent(event: AuditEvent, names: ReadonlyMap<string, string>, shopNames: ReadonlyMap<string, string>) {
  const who = names.get(event.entity_id ?? "") ?? event.entity_id ?? "Unknown account";
  const title = `${ACTIONS[event.action] ?? event.action} · ${who}${event.shop_id ? ` · ${shopNames.get(event.shop_id) ?? event.shop_id}` : ""}`;
  const meta = (event.metadata ?? {}) as { before?: { role?: string; is_active?: boolean }; after?: { role?: string; is_active?: boolean }; role?: string };
  const parts: string[] = [];
  if (event.action === "account.update" && meta.before && meta.after) {
    if (meta.before.role !== meta.after.role) parts.push(`Role ${roleLabel(String(meta.before.role))} → ${roleLabel(String(meta.after.role))}`);
    if (meta.before.is_active !== meta.after.is_active) parts.push(`${statusLabel(Boolean(meta.before.is_active))} → ${statusLabel(Boolean(meta.after.is_active))}`);
  }
  if (event.action === "account.register" && meta.role) parts.push(`Role ${roleLabel(meta.role)}`);
  if (event.reason) parts.push(`Reason: ${event.reason}`);
  return { title, detail: parts.join(" · ") };
}
