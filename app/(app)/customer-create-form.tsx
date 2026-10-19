"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlusIcon } from "lucide-react";

import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { cn } from "@/lib/utils";
import { createCustomer } from "./customer-actions";

/** "Add customer" opens the existing create_customer flow in a drawer; on success it goes to the new customer. */
export function CustomerCreateForm({ shopId, className }: { shopId: string; className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
  return <>
    <button data-slot="button" type="button" className={cn(ui.primary, className)} onClick={() => setOpen(true)}><UserPlusIcon aria-hidden />Add customer</button>
    <Drawer open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }} title="Add customer" description="A name or a mobile number is enough. Mobile numbers are unique within this shop.">
      <form className="grid gap-4" onSubmit={save}>
        <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Name</span>
          <input data-slot="input" aria-label="Name" value={name} maxLength={160} autoComplete="off" onChange={(e) => setName(e.target.value)} className={ui.field} />
        </label>
        <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Mobile</span>
          <input data-slot="input" aria-label="Mobile" value={mobile} maxLength={40} inputMode="tel" autoComplete="off" onChange={(e) => setMobile(e.target.value)} className={ui.field} />
        </label>
        {message && <p role="alert" className={ui.danger}>{message}</p>}
        <button data-slot="button" className={ui.primary} disabled={busy || (!name.trim() && !mobile.trim())}>{busy ? "Saving…" : "Create customer"}</button>
      </form>
    </Drawer>
  </>;
}
