"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Light / Dark / System as radio items, for this menu and the profile menu. */
export function ThemeChoices() {
  const { theme, setTheme } = useTheme();
  // The stored choice is unknown during server render, so no item is marked until mounted.
  return <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
    <DropdownMenuRadioItem value="light"><SunIcon />Light</DropdownMenuRadioItem>
    <DropdownMenuRadioItem value="dark"><MoonIcon />Dark</DropdownMenuRadioItem>
    <DropdownMenuRadioItem value="system"><MonitorIcon />System</DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>;
}

export function ThemeToggle({ className }: { className?: string }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="Theme" className={cn("size-10 rounded-full", className)}>
        <SunIcon className="dark:hidden" /><MoonIcon className="hidden dark:block" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="rounded-2xl p-1.5">
      <ThemeChoices />
    </DropdownMenuContent>
  </DropdownMenu>;
}
