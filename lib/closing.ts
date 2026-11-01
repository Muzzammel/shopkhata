import { z } from "zod";

import type { Role } from "@/lib/auth/permissions";
import { SHOP_INACTIVE_MESSAGE } from "@/lib/shop-admin";

// Input shapes for the close/reopen RPCs. The database repeats every check;
// these only give the user an early, readable answer.
export const closeInput = z.object({ shop_id: z.uuid(), business_date: z.iso.date(), note: z.string().trim().min(1).max(2000).optional() }).strict();
export const reopenInput = z.object({ shop_id: z.uuid(), business_date: z.iso.date(), reason: z.string().trim().min(1).max(2000) }).strict();

export type CloseEvent = { sequence: number; type: "closed" | "reopened"; actorId: string | null; recordedAt: string; reason: string | null; note: string | null };

/** A date is closed when its latest event says so; no events means it was never closed. */
export function dayState(events: readonly Pick<CloseEvent, "sequence" | "type">[]): "open" | "closed" {
  const latest = events.reduce<Pick<CloseEvent, "sequence" | "type"> | null>((last, event) => !last || event.sequence > last.sequence ? event : last, null);
  return latest?.type === "closed" ? "closed" : "open";
}

/** Mirrors the database rule: an owner may reopen any date, a manager only the current Qatar date. */
export function canReopenDate(role: Role, businessDate: string, today: string): boolean {
  return role === "owner" || (role === "manager" && businessDate === today);
}

export function closingError(code: string): string {
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: "Sign in again to continue.",
    UNAUTHORIZED_SHOP: "You cannot close or reopen dates for this shop.",
    INSUFFICIENT_ROLE: "Only a manager or owner can close a date. Reopening an earlier date needs the owner.",
    INVALID_REQUEST: "Check the date and the text you entered.",
    INVALID_DATE: "A future date cannot be closed.",
    REASON_REQUIRED: "Enter a reason for reopening this date.",
    ALREADY_CLOSED: "This date is already closed. Refresh to see who closed it.",
    NOT_CLOSED: "This date is not closed. Refresh to see its current state.",
    SHOP_INACTIVE: SHOP_INACTIVE_MESSAGE,
  };
  return Object.hasOwn(messages, code) ? messages[code] : "The date could not be changed. Refresh and try again.";
}
