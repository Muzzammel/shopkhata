"use client";

import { BellIcon } from "lucide-react";
import { Popover } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The bell's panel. ShopKhata has no notification feed yet, so this is the honest empty state. */
export function NotificationsMenu({ children, side = "bottom", align = "end" }: { children: ReactNode; side?: "bottom" | "right"; align?: "start" | "end" }) {
  return <Popover.Root>
    <Popover.Trigger asChild>{children}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side={side} align={align} sideOffset={10} collisionPadding={12}
        className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-3xl border border-border bg-popover p-5 text-popover-foreground shadow-[var(--shadow-lift)] outline-none sk-enter"
      >
        <h2 className="text-sm font-semibold">Notifications</h2>
        <div className="mt-3 grid place-items-center gap-2 rounded-2xl bg-muted px-4 py-7 text-center">
          <BellIcon aria-hidden className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">You&apos;re all caught up</p>
          <p className="text-xs text-muted-foreground">Alerts that need action, such as a pending Daily Close or an overdue backup, are listed under Needs Attention on the Dashboard.</p>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export const bellClass = (className?: string) => cn("grid size-10 cursor-pointer place-items-center rounded-full text-foreground sk-press hover:bg-muted data-[state=open]:bg-muted", className);
