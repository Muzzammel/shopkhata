"use client";

import { useRouter } from "next/navigation";

import { clearSessionMarker, deleteUserDrafts, listDraftShopIds } from "@/lib/offline/draft-store";
import { createBrowserClient } from "@/lib/supabase/browser";

export function SignOut({ userId }: { userId: string }) {
  const router = useRouter();
  async function signOut() {
    // An explicit sign-out hands the device to someone else, so no readable
    // draft of this user may stay behind.
    const drafts = await listDraftShopIds(userId);
    if (drafts.length && !window.confirm("Sign out and discard the unsaved draft on this device? Anything not confirmed as saved will not be retried.")) return;
    await deleteUserDrafts(userId);
    await clearSessionMarker();
    try { await createBrowserClient().auth.signOut(); } catch { /* the login page still requires a fresh sign-in */ }
    router.replace("/login");
    router.refresh();
  }
  return <button type="button" onClick={() => void signOut()} style={{ border: 0, background: "none", color: "#155a7c", font: "inherit", cursor: "pointer", padding: 0 }}>Sign out</button>;
}
