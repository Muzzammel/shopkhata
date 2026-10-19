"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

import { qar } from "@/lib/dashboard-view";
import type { InvoiceListRow } from "@/lib/invoice-list";
import { invoiceBadges, longDate } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

import { InvoiceBadges } from "./invoice-badges";

// data-slot opts the cells out of the legacy table base styles; below lg each row becomes a card.
const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("sticky top-[65px] z-10 bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;
const money = "text-right tabular-nums whitespace-nowrap";

/**
 * One client boundary for the whole table: rendered from the server page, each row's Link would
 * stream as its own segment and leave empty hidden tables behind in the document.
 */
export function SalesTable({ rows, shopId }: { rows: InvoiceListRow[]; shopId: string }) {
  const invoiceHref = (id: string) => `/shops/${shopId}/invoices/${id}`;
  return <section aria-label="Invoices" className="rounded-3xl border-border lg:border lg:bg-card">
      <table data-slot="sales-table" className="w-full border-separate border-spacing-0 tabular-nums max-lg:block">
        <thead data-slot="head" className="max-lg:sr-only">
          <tr data-slot="row"><Th className="rounded-tl-3xl">Invoice</Th><Th>Business date</Th><Th>Customer</Th><Th className="text-right">Total</Th><Th className="text-right">Received</Th><Th className="text-right">Due</Th><Th className="rounded-tr-3xl">Status</Th></tr>
        </thead>
        <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">
          {rows.map((row) => <tr key={row.invoiceId} data-slot="row" className="group/row relative transition-colors duration-150 hover:bg-muted/60 max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-4 max-lg:gap-y-1.5 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
            <Td className="max-lg:col-start-1 max-lg:row-start-1">
              {/* The number link stretches over the whole row, so any click on it opens the invoice. */}
              <Link href={invoiceHref(row.invoiceId)} aria-label={`View invoice ${row.invoiceNumber}`} className="font-semibold text-foreground no-underline outline-offset-2 after:absolute after:inset-0 after:rounded-2xl group-hover/row:underline">{row.invoiceNumber}</Link>
            </Td>
            <Td className="text-sm text-muted-foreground max-lg:col-start-1 max-lg:row-start-2 max-lg:text-xs">{longDate(row.businessDate)}</Td>
            <Td className="text-sm max-lg:col-span-2 max-lg:row-start-3 max-lg:text-xs max-lg:text-muted-foreground">{row.customerName || <span className="text-muted-foreground">No customer</span>}</Td>
            <Td className={cn(money, "font-semibold max-lg:col-start-2 max-lg:row-start-1 max-lg:text-base")}>{qar(row.totalDirham)}</Td>
            <Td className={cn(money, "text-sm max-lg:col-start-1 max-lg:row-start-4 max-lg:mt-2 max-lg:text-left max-lg:text-xs max-lg:text-muted-foreground")}>
              <span className="lg:hidden">Received </span>{qar(row.paidDirham)}
              {row.creditAppliedDirham > 0 && <span className="block text-xs text-muted-foreground">+ {qar(row.creditAppliedDirham)} credit</span>}
            </Td>
            <Td className={cn(money, "text-sm max-lg:col-start-2 max-lg:row-start-4 max-lg:mt-2 max-lg:text-xs", row.dueDirham > 0 ? "font-semibold text-warning" : "text-muted-foreground")}><span className="lg:hidden">Due </span>{qar(row.dueDirham)}</Td>
            <Td className="max-lg:col-start-2 max-lg:row-start-2 max-lg:justify-self-end">
              <InvoiceBadges badges={invoiceBadges(row)} />
              {!row.delivered && <span className="ml-1 text-[11px] font-medium text-muted-foreground">Not delivered</span>}
            </Td>
          </tr>)}
        </tbody>
      </table>
    </section>;
}