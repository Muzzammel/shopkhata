import type { Metadata } from "next";

import { APP_NAME } from "@/lib/domain/constants";

import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Two-shop financial operations.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
