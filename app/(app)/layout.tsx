import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getCurrentActor } from "@/lib/auth/permissions";

export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  try {
    await getCurrentActor();
  } catch {
    redirect("/login");
  }

  return children;
}
