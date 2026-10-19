"use client";

import Link from "next/link";
import { BellIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { NotificationsMenu } from "./notifications-menu";
import type { QuickAction } from "./quick-actions";

const button = "grid size-11 cursor-pointer place-items-center rounded-full no-underline outline-offset-2 sk-press";

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent side="right" sideOffset={10}>{label}</TooltipContent></Tooltip>;
}

/** The floating icon rail on tablet and desktop. Stays put while the page scrolls. */
export function QuickActionRail({ actions, onSearch }: { actions: QuickAction[]; onSearch: () => void }) {
  return <nav aria-label="Quick actions" className="fixed top-24 left-3 z-30 hidden flex-col items-center gap-1 rounded-full border border-border bg-card p-1.5 shadow-[var(--shadow-lift)] sk-fade md:flex lg:left-4">
    {actions.map(({ key, label, href, icon: Icon, primary }) => <Tip key={key} label={label}>
      <Link href={href} aria-label={label} className={cn(button, primary ? "bg-yellow text-on-yellow hover:brightness-95" : "text-foreground hover:bg-muted")}><Icon aria-hidden className="size-5" /></Link>
    </Tip>)}
    <span aria-hidden className="my-1 h-px w-6 bg-border" />
    <Tip label="Quick find (Ctrl K)">
      <button type="button" data-slot="rail" aria-label="Quick find" onClick={onSearch} className={cn(button, "text-foreground hover:bg-muted")}><SearchIcon aria-hidden className="size-5" /></button>
    </Tip>
    <Tooltip>
      <NotificationsMenu side="right" align="start">
        <TooltipTrigger asChild>
          <button type="button" data-slot="rail" aria-label="Notifications" className={cn(button, "text-foreground hover:bg-muted data-[state=open]:bg-muted")}><BellIcon aria-hidden className="size-5" /></button>
        </TooltipTrigger>
      </NotificationsMenu>
      <TooltipContent side="right" sideOffset={10}>Notifications</TooltipContent>
    </Tooltip>
  </nav>;
}
