import { createServerSupabaseClient } from "@/lib/supabase/server";

export type Role = "owner" | "manager" | "staff";

export type Permission =
  | "correction.request"
  | "invoice.replacement.request"
  | "invoice.replacement.approve"
  | "batch.enter"
  | "payment.record"
  | "expense.create"
  | "invoice.deliver_due"
  | "records.view_assigned"
  | "reports.view_all"
  | "payment.override_excess"
  | "correction.approve"
  | "date.close"
  | "date.reopen"
  | "users.manage"
  | "records.export"
  | "batch.import"
  | "audit.view_full";

export type Actor = {
  id: string;
  role: Role;
  isActive: boolean;
  shopIds: readonly string[];
};

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    "correction.request",
    "invoice.replacement.request",
    "batch.enter",
    "payment.record",
    "expense.create",
    "invoice.deliver_due",
    "records.view_assigned",
    "reports.view_all",
    "payment.override_excess",
    "invoice.replacement.approve",
    "correction.approve",
    "date.close",
    "date.reopen",
    "users.manage",
    "records.export",
    "batch.import",
    "audit.view_full",
  ],
  manager: [
    "correction.request",
    "invoice.replacement.request",
    "batch.enter",
    "payment.record",
    "expense.create",
    "invoice.deliver_due",
    "records.view_assigned",
    "payment.override_excess",
    "invoice.replacement.approve",
    "correction.approve",
    "date.close",
    "date.reopen",
    "records.export",
    "batch.import",
    "audit.view_full",
  ],
  staff: [
    "correction.request",
    "invoice.replacement.request",
    "batch.enter",
    "payment.record",
    "expense.create",
    "invoice.deliver_due",
    "records.view_assigned",
    "records.export",
    "batch.import",
  ],
};

const SCOPED_PERMISSIONS = new Set<Permission>([
  "correction.request",
  "invoice.replacement.request",
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "records.view_assigned",
  "payment.override_excess",
  "invoice.replacement.approve",
  "correction.approve",
  "date.close",
  "date.reopen",
  "records.export",
  "batch.import",
  "audit.view_full",
]);

const MUTATION_PERMISSIONS = new Set<Permission>([
  "correction.request",
  "invoice.replacement.request",
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "payment.override_excess",
  "invoice.replacement.approve",
  "correction.approve",
  "date.close",
  "date.reopen",
  "users.manage",
  "batch.import",
]);

const KNOWN_PERMISSIONS = new Set<Permission>([
  ...ROLE_PERMISSIONS.owner,
]);

function isRole(value: unknown): value is Role {
  return value === "owner" || value === "manager" || value === "staff";
}

function isTrustedActorShape(actor: Actor): boolean {
  return (
    typeof actor === "object" &&
    actor !== null &&
    typeof actor.id === "string" &&
    actor.id.length > 0 &&
    isRole(actor.role) &&
    typeof actor.isActive === "boolean" &&
    Array.isArray(actor.shopIds) &&
    actor.shopIds.every(
      (shopId): shopId is string =>
        typeof shopId === "string" && shopId.length > 0,
    )
  );
}

export function can(
  actor: Actor,
  action: Permission,
  shopId?: string,
): boolean {
  if (!isTrustedActorShape(actor) || !KNOWN_PERMISSIONS.has(action)) {
    return false;
  }

  if (!actor.isActive && MUTATION_PERMISSIONS.has(action)) {
    return false;
  }

  if (!ROLE_PERMISSIONS[actor.role].includes(action)) {
    return false;
  }

  if (!SCOPED_PERMISSIONS.has(action)) {
    return true;
  }

  if (typeof shopId !== "string" || shopId.length === 0) {
    return false;
  }

  return actor.role === "owner" || actor.shopIds.includes(shopId);
}

function failClosed(message: string): never {
  throw new Error(message);
}

export async function getCurrentActor(): Promise<Actor> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    failClosed("AUTHENTICATION_REQUIRED");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (
    profileError ||
    !profile ||
    profile.id !== user.id ||
    typeof profile.role !== "string" ||
    !isRole(profile.role) ||
    typeof profile.is_active !== "boolean"
  ) {
    failClosed("TRUSTED_PROFILE_REQUIRED");
  }

  const { data: assignments, error: assignmentError } = await supabase
    .from("user_shop_assignments")
    .select("shop_id")
    .eq("user_id", user.id);

  if (
    assignmentError ||
    !assignments ||
    assignments.some(
      (assignment) =>
        typeof assignment.shop_id !== "string" ||
        assignment.shop_id.length === 0,
    )
  ) {
    failClosed("TRUSTED_ASSIGNMENTS_REQUIRED");
  }

  return {
    id: user.id,
    role: profile.role,
    isActive: profile.is_active,
    shopIds: assignments.map((assignment) => assignment.shop_id),
  };
}
