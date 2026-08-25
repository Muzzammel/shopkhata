import { APP_NAME } from "@/lib/domain/constants";

import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="app-name">
        <p className={styles.eyebrow}>Application foundation</p>
        <h1 id="app-name">{APP_NAME}</h1>
        <p className={styles.summary}>Two-shop financial operations.</p>
      </section>
    </main>
  );
}
