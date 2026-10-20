import Link from "next/link";

import { Notice } from "@/components/shell/notice";
import { ui } from "@/components/sales/ui";

export default function InvoiceNotFound() {
  return <Notice title="Invoice not found" action={<Link href="/invoices" data-slot="button" className={ui.secondary}>Back to sales</Link>}>
    <p>The invoice is unavailable in this shop.</p>
  </Notice>;
}
