"use client";

import { useId } from "react";
import { CheckIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { PAYMENT_METHODS, paymentMethodLabel, type PaymentMethod } from "@/lib/payment-method";
import { cn } from "@/lib/utils";

/**
 * Cash or Bank for money received. Native radios give the group its keyboard behaviour (arrow keys)
 * and screen-reader semantics; the selected option also shows a check mark, never colour alone.
 */
export function PaymentMethodField({ value, onChange, disabled = false, label = "Payment method", name, className }: {
  value: PaymentMethod; onChange: (method: PaymentMethod) => void; disabled?: boolean; label?: string; name?: string; className?: string;
}) {
  const group = useId();
  return <fieldset data-slot="payment-method" disabled={disabled} className={cn("m-0 grid min-w-0 gap-1.5 border-0 p-0", className)}>
    <legend className={cn(ui.label, "p-0")}>{label}</legend>
    <div className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1">
      {PAYMENT_METHODS.map((method) => {
        const selected = method === value;
        return <label key={method} data-slot="label" className={cn(
          "relative inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold sk-press has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)] max-sm:min-h-12",
          selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-card hover:text-foreground",
          disabled && "cursor-not-allowed opacity-60",
        )}>
          <input data-slot="radio" type="radio" name={name ?? group} value={method} checked={selected} disabled={disabled} onChange={() => onChange(method)} className="absolute inset-0 size-full cursor-[inherit] opacity-0" />
          {selected && <CheckIcon aria-hidden className="size-4" />}
          {paymentMethodLabel(method)}
        </label>;
      })}
    </div>
  </fieldset>;
}
