import { z } from "zod";

const role = z.enum(["owner", "manager", "staff"]);

export const registerAccountInput = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  display_name: z.string().trim().min(1).max(200),
  role,
});
export const updateAccountInput = z.strictObject({ user_id: z.uuid(), role, is_active: z.boolean() });
export const shopAssignmentInput = z.strictObject({ user_id: z.uuid(), shop_id: z.uuid(), assigned: z.boolean() });

export const ACCOUNT_ADMIN_RPCS = {
  admin_register_account: registerAccountInput,
  admin_update_account: updateAccountInput,
  admin_set_shop_assignment: shopAssignmentInput,
} as const;

const MESSAGES: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "Sign in again to manage accounts.",
  INSUFFICIENT_ROLE: "Only an owner can manage accounts.",
  INVALID_REQUEST: "Check the details and try again.",
  ACCOUNT_NOT_FOUND: "No sign-in exists for that email. Create the user in the Supabase dashboard first, then register it here.",
  ACCOUNT_EXISTS: "That sign-in already has a ShopKhata account.",
  SELF_CHANGE_FORBIDDEN: "You cannot change your own role or status. Ask another owner.",
  SHOP_NOT_FOUND: "That shop no longer exists.",
};

export function accountAdminError(code: string): string {
  return MESSAGES[code] ?? "The change was not saved. Refresh to see the current accounts.";
}

/** What an account can actually reach right now, in words an owner can check at a glance. */
export function effectiveAccess(account: { role: string; isActive: boolean; shopNames: readonly string[] }): string {
  if (!account.isActive) return "No access (deactivated)";
  if (account.role === "owner") return "All shops (owner)";
  return account.shopNames.length ? account.shopNames.join(", ") : "No access (no shop assigned)";
}
