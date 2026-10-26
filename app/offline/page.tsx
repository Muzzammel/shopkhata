"use client";

import { useEffect, useState } from "react";

import { APP_NAME } from "@/lib/domain/constants";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { readSessionMarker, type SessionMarker } from "@/lib/offline/draft-store";
import { assumeOffline } from "@/lib/offline/use-online";

import { InvoiceEntry } from "../(app)/invoice-entry";
import styles from "../ui.module.css";

async function serverReachable(): Promise<boolean> {
  try {
    return (await fetch("/sw.js", { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(4_000) })).ok;
  } catch {
    return false;
  }
}

/** Back to the real, server-authenticated workspace. */
function leave() {
  if (window.location.pathname === "/offline") window.location.replace("/");
  else window.location.reload();
}

/**
 * The page the service worker serves when loading the workspace fails. It is
 * static and holds no server data: it only reopens the local draft of the
 * user who last had a live session in this browser, and only while the
 * server cannot be reached to authenticate anyone.
 */
export default function OfflinePage() {
  const [state, setState] = useState<{ marker: SessionMarker | null; today: string } | null>(null);
  useEffect(() => {
    let active = true;
    assumeOffline();
    // The browser's online event alone is not enough to leave: it never fires
    // if the device kept reporting a connection while the server was unreachable.
    const check = async () => {
      if (await serverReachable()) return leave();
      if (!active) return;
      const marker = await readSessionMarker();
      if (active) setState((current) => current ?? { marker, today: qatarBusinessDate(new Date()) });
    };
    void check();
    const probe = window.setInterval(() => void check(), 5_000);
    window.addEventListener("online", leave);
    return () => {
      active = false;
      window.clearInterval(probe);
      window.removeEventListener("online", leave);
    };
  }, []);
  if (!state) return <main className={styles.notice}><p role="status">Loading…</p></main>;
  const shop = state.marker?.shops.find((item) => item.id === state.marker?.shopId) ?? state.marker?.shops[0];
  if (!state.marker || !shop) {
    return <main className={styles.notice}>
      <h1>{APP_NAME} is offline</h1>
      <p>Reconnect and sign in to continue. Any unsaved draft on this device opens again after you sign in.</p>
    </main>;
  }
  return <InvoiceEntry
    offlineShell appName={APP_NAME} shop={shop} shops={state.marker.shops}
    actorId={state.marker.userId} actorName={state.marker.name} actorRole={state.marker.role}
    invoices={[]} businessDate={state.today}
  />;
}
