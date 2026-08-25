import type { MetadataRoute } from "next";

import { APP_NAME } from "@/lib/domain/constants";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Two-shop financial operations.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f7fa",
    theme_color: "#172b4d",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
