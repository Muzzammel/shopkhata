"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

import { qar } from "@/lib/dashboard-view";
import { balanceStatuses } from "@/lib/customer-view";
import { longDate } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

import { BalanceBadges, CustomerAvatar } from "./customer-status";

export type DirectoryRow = {
  id: string; publicId: string; name: string | null; mobile: string | null;
  dueDirham: number; creditDirham: number; invoiceCount: number; lastActivityDate: string | null;
};

// data-slot opts the cells out of the legacy table base styles; below lg each row becomes a card.
const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("sticky top-[65px] z-10 bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;
const money = "text-right tabular-nums whitespace-nowrap";

/** One client boundary for the whole list, like the Sales table, so rows never stream as separate segments. */
export function CustomerDirectory({ rows, shopId }: { rows: DirectoryRow[]; shopId: string }) {
  return <section aria-label="Customers" className="rounded-3xl border-border lg:border lg:bg-card">
    <table data-slot="customer-table" className="w-full border-separate border-spacing-0 tabular-nums max-lg:block">
      <thead data-slot="head" className="max-lg:sr-only">
        <tr data-slot="row"><Th className="rounded-tl-3xl">Customer</Th><Th>Mobile</Th><Th>Balance</Th><Th className="text-right">Invoices</Th><Th className="text-right">Due</Th><Th className="text-right">Credit</Th><Th className="rounded-tr-3xl">Last activity</Th></tr>
      </thead>
      <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">
        {rows.map((row) => {
          const name = row.name || "Unnamed customer";
          return <tr key={row.id} data-slot="row" data-customer={row.publicId} className="group/row relative transition-colors duration-150 hover:bg-muted/60 max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-4 max-lg:gap-y-2 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
            <Td className="max-lg:col-start-1 max-lg:row-start-1">
              <span className="flex min-w-0 items-center gap-3">
                <CustomerAvatar name={name} />
                <span className="grid min-w-0">
                  {/* The name link stretches over the whole row, so any click on it opens the customer. */}
                  <Link href={`/customers/${row.id}?shop=${shopId}`} className="truncate font-semibold text-foreground no-underline outline-offset-2 after:absolute after:inset-0 after:rounded-2xl group-hover/row:underline">{name}</Link>
                  <span className="truncate text-xs text-muted-foreground"><span className="lg:hidden">{row.mobile ? `${row.mobile} · ` : ""}</span>{row.publicId}</span>
                </span>
              </span>
            </Td>
            <Td className="text-sm max-lg:hidden">{row.mobile || <span className="text-muted-foreground">—</span>}</Td>
            <Td className="max-lg:col-span-2 max-lg:row-start-2"><BalanceBadges states={balanceStatuses(row)} /></Td>
            <Td className={cn(money, "text-sm text-muted-foreground max-lg:col-start-1 max-lg:row-start-3 max-lg:text-left max-lg:text-xs")}>{row.invoiceCount}<span className="lg:hidden"> invoice{row.invoiceCount === 1 ? "" : "s"}{row.lastActivityDate && ` · last activity ${longDate(row.lastActivityDate)}`}</span></Td>
            <Td className={cn(money, "max-lg:col-start-2 max-lg:row-start-1 max-lg:self-center", row.dueDirham > 0 ? "font-semibold text-warning" : "text-sm text-muted-foreground")}><span className="sr-only lg:hidden">Due </span>{row.dueDirham > 0 ? qar(row.dueDirham) : <span className="text-sm">No due</span>}</Td>
            <Td className={cn(money, "text-sm max-lg:col-start-2 max-lg:row-start-3 max-lg:text-xs", row.creditDirham > 0 ? "font-medium text-foreground" : "text-muted-foreground max-lg:hidden")}><span className="lg:hidden">Credit </span>{row.creditDirham > 0 ? qar(row.creditDirham) : "—"}</Td>
            <Td className="text-sm whitespace-nowrap text-muted-foreground max-lg:hidden">{row.lastActivityDate ? longDate(row.lastActivityDate) : "—"}</Td>
          </tr>;
        })}
      </tbody>
    </table>
  </section>;
}
