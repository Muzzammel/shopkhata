import type { ReactNode } from "react";

/** Re-mounts on every navigation between pages, so each screen rises in (reduced motion: appears). */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="sk-page">{children}</div>;
}
