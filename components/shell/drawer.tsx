"use client";

import { useRef, type ReactNode, type RefObject } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/** A side drawer on desktop, a full-screen sheet on phones. Calm entrance: governed actions should not feel playful. */
export function Drawer({ open, onOpenChange, title, description, children, fallbackFocus }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; children: ReactNode; fallbackFocus?: RefObject<HTMLElement | null> }) {
  // Opened from state, not a Radix trigger, so return focus to whatever opened it ourselves.
  // A menu item that opened it is gone by then, so focus goes back to the menu's button.
  const opener = useRef<HTMLElement | null>(null);
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" onOpenAutoFocus={() => { const active = document.activeElement as HTMLElement | null; opener.current = active?.closest("[role=menu]") ? null : active; }} onCloseAutoFocus={(event) => { event.preventDefault(); (opener.current?.isConnected ? opener.current : fallbackFocus?.current)?.focus(); }} className="w-full! gap-0 overflow-y-auto border-border bg-card p-0 duration-300 sm:max-w-md!">
      <SheetHeader className="sticky top-0 z-10 gap-1 border-b border-border bg-card px-5 pt-5 pb-4 pr-14 sm:px-6">
        <SheetTitle className="text-lg font-semibold tracking-tight">{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>
      <div className="grid gap-5 px-5 py-5 sm:px-6">{children}</div>
    </SheetContent>
  </Sheet>;
}
