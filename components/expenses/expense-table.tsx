"use client";

import Link from "next/link";
import { PaperclipIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { qar } from "@/lib/dashboard-view";
import { expenseFlags } from "@/lib/expense-view";
import { longDate } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

import { ExpenseCategoryBadge, ExpenseFlags } from "./expense-badges";

export type ExpenseRow = {
  id: string; businessDate: string; category: string; description: string; amountDirham: number;
  receiptCount: number; pendingCount: number; corrected: boolean; backdated: boolean;
};

// data-slot opts the cells out of the legacy table base styles; below lg each row becomes a card.
const Th = ({ className, ...props }: ComponentProps<"th">) => <th data-slot="cell" scope="col" className={cn("sticky top-[65px] z-10 bg-card px-4 py-3 text-left text-xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]", className)} {...props} />;
const Td = ({ className, ...props }: ComponentProps<"td">) => <td data-slot="cell" className={cn("px-4 py-3 align-middle lg:border-b lg:border-border max-lg:p-0", className)} {...props} />;

/** One client boundary for the whole list, like the Sales table, so rows never stream as separate segments. */
export function ExpenseTable({ rows, shopId }: { rows: ExpenseRow[]; shopId: string }) {
  return <section aria-label="Expenses" className="rounded-3xl border-border lg:border lg:bg-card">
    <table data-slot="expense-table" className="w-full border-separate border-spacing-0 tabular-nums max-lg:block">
      <thead data-slot="head" className="max-lg:sr-only">
        <tr data-slot="row"><Th className="rounded-tl-3xl">Date</Th><Th>Category</Th><Th>Description</Th><Th className="text-right">Amount</Th><Th>Receipt</Th><Th className="rounded-tr-3xl">Status</Th></tr>
      </thead>
      <tbody data-slot="body" className="max-lg:grid max-lg:gap-3 sm:max-lg:grid-cols-2">
        {rows.map((row) => {
          const flags = expenseFlags(row);
          return <tr key={row.id} data-slot="row" data-expense={row.id} className="group/row relative transition-colors duration-150 hover:bg-muted/60 max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-4 max-lg:gap-y-1.5 max-lg:rounded-2xl max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-4 lg:[&:last-child>td]:border-b-0">
            <Td className="text-sm whitespace-nowrap text-muted-foreground max-lg:col-start-1 max-lg:row-start-3 max-lg:text-xs">{longDate(row.businessDate)}</Td>
            <Td className="max-lg:col-start-1 max-lg:row-start-1"><ExpenseCategoryBadge category={row.category} /></Td>
            <Td className="max-w-[28rem] max-lg:col-span-2 max-lg:row-start-2 max-lg:max-w-none">
              {/* The description link stretches over the whole row, so any click on it opens the expense. */}
              <Link href={`/expenses/${row.id}?shop=${shopId}`} className="line-clamp-2 text-[15px] font-medium text-foreground no-underline outline-offset-2 [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-2xl group-hover/row:underline lg:text-sm">{row.description}</Link>
            </Td>
            <Td className="text-right text-base font-semibold whitespace-nowrap max-lg:col-start-2 max-lg:row-start-1 max-lg:self-center max-lg:text-lg">{qar(row.amountDirham)}</Td>
            <Td className="text-sm max-lg:col-start-2 max-lg:row-start-3 max-lg:justify-self-end">
              {row.receiptCount > 0
                ? <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground"><PaperclipIcon aria-hidden className="size-3.5" />Receipt</span>
                : <span className="text-xs text-muted-foreground"><span aria-hidden className="max-lg:hidden">—</span><span className="sr-only">No receipt</span></span>}
            </Td>
            <Td className={cn("max-lg:col-span-2 max-lg:row-start-4", flags.length === 0 && "max-lg:hidden")}>{flags.length ? <ExpenseFlags flags={flags} /> : <span className="text-xs text-muted-foreground">—</span>}</Td>
          </tr>;
        })}
      </tbody>
    </table>
  </section>;
}
