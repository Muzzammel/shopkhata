import Link from "next/link";

import { Notice } from "@/components/shell/notice";
import { ui } from "@/components/sales/ui";

export default function NotFound() {
  return <Notice title="Page not found" action={<Link href="/dashboard" data-slot="button" className={ui.secondary}>Go to dashboard</Link>}>
    <p>This page does not exist, or it belongs to a shop this account cannot open.</p>
  </Notice>;
}
