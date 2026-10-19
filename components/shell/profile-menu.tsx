"use client";

import { LogOutIcon } from "lucide-react";

import { useSignOut } from "@/app/(app)/sign-out";
import { ThemeChoices } from "@/components/theme-toggle";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/dashboard-view";

export type ShellUser = { id: string; name: string; role: string };

export function ProfileMenu({ user }: { user: ShellUser }) {
  const signOut = useSignOut(user.id);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" data-slot="profile" aria-label="Profile" className="grid size-10 cursor-pointer place-items-center rounded-full outline-offset-2 sk-press">
        <span aria-hidden className="grid size-9 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(user.name)}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-56 rounded-2xl p-1.5">
      <DropdownMenuLabel className="grid gap-0.5 py-2">
        <span className="text-sm font-semibold text-foreground">{user.name}</span>
        <span className="text-xs font-normal text-muted-foreground capitalize">{user.role}</span>
      </DropdownMenuLabel>
      {/* The top bar's Theme button is hidden on phones; the choice lives here instead. */}
      <div className="md:hidden">
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
        <ThemeChoices />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void signOut()} className="min-h-9 rounded-xl"><LogOutIcon />Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
