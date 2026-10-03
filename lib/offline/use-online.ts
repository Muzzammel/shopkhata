import { useSyncExternalStore } from "react";

let assumedOffline = false;
const listeners = new Set<() => void>();

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

/** The app's single answer to "can we reach the server right now?". */
export function isOnline(): boolean {
  return navigator.onLine && !assumedOffline;
}

/**
 * Called by the offline page. It is only ever shown because a page load
 * failed, so the app is offline even when the browser still reports a
 * connection (for example Wi-Fi with no internet behind it).
 */
export function assumeOffline(): void {
  assumedOffline = true;
  for (const notify of listeners) notify();
}

/** Connectivity as a React value. True on the server and until the browser reports otherwise. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
