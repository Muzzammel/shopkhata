import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import Link from "next/link";

import styles from "@/app/ui.module.css";

import { MainNav } from "./main-nav";
import { SignOut } from "./sign-out";

export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  let actor: Actor;
  try {
    actor = await getCurrentActor();
  } catch {
    redirect("/login");
  }

  // The database already refuses a deactivated account every read and write;
  // this tells the person why instead of showing empty screens.
  if (!actor.isActive) {
    return <main className={styles.notice}>
      <h1>Account deactivated</h1>
      <p role="alert">This account has been deactivated by an owner and can no longer view or record anything. Ask an owner if this is a mistake.</p>
      <SignOut userId={actor.id} />
    </main>;
  }

  return <><header className={styles.appBar}>
    <Link href="/" className={styles.brand}>ShopKhata</Link>
    <MainNav showAccounts={can(actor, "users.manage")} />
    <SignOut userId={actor.id} />
  </header>{children}</>;
}
