import { APP_NAME } from "@/lib/domain/constants";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "../page.module.css";

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const { data: shops, error } = await supabase
    .from("shops")
    .select("id, name")
    .order("name");

  if (error) {
    throw new Error("SHOP_VISIBILITY_UNAVAILABLE");
  }

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="app-name">
        <p className={styles.eyebrow}>Application foundation</p>
        <h1 id="app-name">{APP_NAME}</h1>
        <p className={styles.summary}>Two-shop financial operations.</p>
        {shops.map((shop) => (
          <h2 key={shop.id}>{shop.name}</h2>
        ))}
      </section>
    </main>
  );
}
