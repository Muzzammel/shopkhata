"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createCustomer } from "./customer-actions";
import styles from "@/app/ui.module.css";

export function CustomerCreateForm({ shopId }: { shopId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await createCustomer({ shop_id: shopId, name: name.trim() || undefined, mobile: mobile.trim() || undefined });
      if (!result.ok) { setMessage(result.message); return; }
      router.push(`/customers/${result.customerId}?shop=${shopId}`);
    } catch { setMessage("Customer status is uncertain. Check the list before retrying."); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel}><h2>Add customer</h2><form className={styles.formGrid} onSubmit={save}>
    <label>Name<input value={name} maxLength={160} onChange={(e) => setName(e.target.value)}/></label>
    <label>Mobile<input value={mobile} maxLength={40} inputMode="tel" onChange={(e) => setMobile(e.target.value)}/></label>
    <button disabled={busy || (!name.trim() && !mobile.trim())}>{busy ? "Saving…" : "Create customer"}</button>
  </form>{message && <p role="alert">{message}</p>}</section>;
}
