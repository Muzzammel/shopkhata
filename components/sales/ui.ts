// Class recipes for the V2 Sales screens. Every element using them also carries a data-slot,
// which keeps the legacy base element styles in globals.css off it.

const pill = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold whitespace-nowrap no-underline sk-press outline-offset-2 disabled:pointer-events-none disabled:opacity-50 max-sm:min-h-12 [&_svg]:size-4 [&_svg]:shrink-0";

export const ui = {
  primary: `${pill} bg-primary text-primary-foreground hover:bg-primary/88`,
  secondary: `${pill} border border-input bg-card text-foreground hover:bg-muted`,
  ghost: `${pill} text-muted-foreground hover:bg-muted hover:text-foreground`,
  quiet: "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-muted-foreground no-underline sk-press hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
  label: "text-[13px] font-medium text-muted-foreground",
  field: "h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3.5 text-[15px] text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/15 max-sm:h-12 max-sm:text-base",
  money: "text-right font-semibold tabular-nums",
  fieldError: "text-[13px] font-medium text-destructive",
  card: "rounded-3xl border border-border bg-card",
  /** Status badge shape; the tone classes are added per use. The word carries the meaning; colour only repeats it. */
  badge: "inline-flex h-5 w-fit items-center rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase",
  /** List-page toolbars (Sales, Customers, Expenses): search field and the pill buttons beside it. */
  toolbarField: "h-10 w-full rounded-full border border-input bg-card px-4 text-sm text-foreground placeholder:text-muted-foreground",
  toolbarButton: "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold no-underline sk-press",
  /** Link pills that switch a view (shop, report, period). */
  chip: "inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold no-underline sk-press",
  /** Serious notices: tinted, bordered on the leading edge, never playful. */
  warn: "rounded-2xl border-l-4 border-warning bg-warning-soft px-4 py-3 text-sm text-foreground",
  danger: "rounded-2xl border-l-4 border-destructive bg-danger-soft px-4 py-3 text-sm text-foreground",
  ok: "rounded-2xl border-l-4 border-success bg-success-soft px-4 py-3 text-sm text-foreground",
};
