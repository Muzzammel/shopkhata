import styles from "@/app/ui.module.css";

export default function InvoiceNotFound() {
  return <main className={styles.notice}><h1>Invoice not found</h1><p>The invoice is unavailable in this shop.</p></main>;
}
