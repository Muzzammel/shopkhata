"use client";

import { useEffect } from "react";

import { useOnline } from "@/lib/offline/use-online";

/** Registers the service worker and shows the app-wide offline indicator. */
export function Pwa() {
  const online = useOnline();
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        // Without a service worker the app still works online; only the offline reload is lost.
      });
    }
  }, []);
  if (online) return null;
  return <div role="status" data-offline-banner style={{ background: "#7c2d12", color: "#fff", padding: "8px 16px", textAlign: "center", fontWeight: 700 }}>
    You are offline. Drafts stay on this device; nothing is saved to ShopKhata until you reconnect.
  </div>;
}
