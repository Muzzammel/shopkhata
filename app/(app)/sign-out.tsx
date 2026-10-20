"use client";

import { useRouter } from "next/navigation";

import { clearSessionMarker, deleteUserDrafts, listDraftShopIds } from "@/lib/offline/draft-store";
import { createBrowserClient } from "@/lib/supabase/browser";

import { ui } from "@/components/sales/ui";

/** Signs the user out. Shared by the profile menu and the "account deactivated" screen. */
export function useSignOut(userId: string) {
  const router = useRouter();
  return async function signOut() {
    // An explicit sign-out hands the device to someone else, so no readable
    // draft of this user may stay behind.
    const drafts = await listDraftShopIds(userId);
    if (drafts.length && !window.confirm("Sign out and discard the unsaved draft on this device? Anything not confirmed as saved will not be retried.")) return;
    await deleteUserDrafts(userId);
    await clearSessionMarker();
    try { await createBrowserClient().auth.signOut(); } catch { /* the login page still requires a fresh sign-in */ }
    router.replace("/login");
    router.refresh();
  };
}

export function SignOut({ userId }: { userId: string }) {
  const signOut = useSignOut(userId);
  return <button type="button" onClick={() => void signOut()} data-slot="button" className={ui.secondary}>Sign out</button>;
}
