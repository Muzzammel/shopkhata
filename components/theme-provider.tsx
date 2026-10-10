"use client";

import type { ReactNode } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Light / Dark / System. next-themes stores the choice in localStorage ("theme") and sets the
 * class on <html> from an inline script that runs before first paint, so there is no flash.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</NextThemesProvider>;
}
