"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { registerAccount, setShopAssignment, updateAccount, type AccountAdminResult } from "./actions";
import styles from "@/app/ui.module.css";

type Shop = { id: string; name: string };
export type AccountRow = { id: string; displayName: string; role: string; isActive: boolean; shopIds: string[] };

function useAdminAction(action: (form: FormData) => Promise<AccountAdminResult>) {
  const router = useRouter();
  return useActionState(async (_previous: string, form: FormData) => {
    try {
      const result = await action(form);
      router.refresh();
      return result.ok ? "Saved." : result.message;
    } catch {
      return "The change was not saved. Refresh to see the current accounts.";
    }
  }, "");
}

const Outcome = ({ message }: { message: string }) => message ? <p role={message === "Saved." ? "status" : "alert"}>{message}</p> : null;

/** Role, status and shop access for one account. Plain form fields; the server validates and authorizes everything again. */
export function AccountForm({ account, shops }: { account: AccountRow; shops: Shop[] }) {
  const [message, submit, busy] = useAdminAction(async (form) => {
    const updated = await updateAccount({ user_id: account.id, role: String(form.get("role")), is_active: form.get("is_active") === "on" });
    if (!updated.ok) return updated;
    for (const shop of shops) {
      const assigned = form.get(`shop-${shop.id}`) === "on";
      if (assigned === account.shopIds.includes(shop.id)) continue;
      const result = await setShopAssignment({ user_id: account.id, shop_id: shop.id, assigned });
      if (!result.ok) return result;
    }
    return { ok: true };
  });

  return <form className={styles.formGrid} action={submit} aria-label={`Manage ${account.displayName}`}>
    <label>Role
      <select name="role" defaultValue={account.role}><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></select>
    </label>
    <label>
      <input type="checkbox" name="is_active" defaultChecked={account.isActive} />Account is active
    </label>
    <fieldset className={styles.checks}>
      <legend>Shop access{account.role === "owner" ? " (an owner can always use every shop)" : ""}</legend>
      {shops.map((shop) => <label key={shop.id}>
        <input type="checkbox" name={`shop-${shop.id}`} defaultChecked={account.shopIds.includes(shop.id)} />{shop.name}
      </label>)}
    </fieldset>
    <button disabled={busy}>{busy ? "Saving…" : "Save account"}</button>
    <Outcome message={message} />
  </form>;
}

export function RegisterAccountForm() {
  const [message, submit, busy] = useAdminAction((form) => registerAccount({
    email: String(form.get("email") ?? ""), display_name: String(form.get("display_name") ?? ""), role: String(form.get("role")),
  }));

  return <form className={styles.formGrid} action={submit}>
    <label>Sign-in email<input type="email" name="email" required maxLength={320} autoComplete="off" /></label>
    <label>Display name<input name="display_name" required maxLength={200} autoComplete="off" /></label>
    <label>Role
      <select name="role" defaultValue="staff"><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></select>
    </label>
    <button disabled={busy}>{busy ? "Saving…" : "Register account"}</button>
    <Outcome message={message} />
  </form>;
}
