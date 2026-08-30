import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

function publicSupabaseConfig(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase browser configuration is unavailable.");
  }

  return { url, key };
}

export function createBrowserClient(): SupabaseClient<Database> {
  const { url, key } = publicSupabaseConfig();
  return createSupabaseBrowserClient<Database>(url, key);
}

export const createBrowserSupabaseClient = createBrowserClient;
