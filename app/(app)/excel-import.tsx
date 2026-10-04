"use client";

import { useState } from "react";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";

import {
  IMPORT_SHEET_NAME, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, importTemplateSheets, parseImportSheet, parsePastedRows,
  type ImportResult,
} from "@/lib/excel/invoice-import";
import type { EntryError, EntryRow } from "@/lib/invoice-entry";

import styles from "./invoice-entry.module.css";

async function downloadTemplate() {
  const url = URL.createObjectURL(await writeXlsxFile(importTemplateSheets()).toBlob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "shopkhata-invoice-import-template.xlsx";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Reads a workbook (or pasted cells) into draft rows and shows them for
 * review. Nothing is saved here: accepted rows only join the draft, which
 * then goes through the normal Review batch and Save batch steps.
 */
export function ExcelImport({ disabled, currentRows, draftIsBlank, validate, onApply }: {
  disabled: boolean;
  currentRows: EntryRow[];
  draftIsBlank: boolean;
  /** The same batch validation manual rows get. */
  validate: (rows: EntryRow[]) => EntryError[];
  onApply: (rows: EntryRow[], mode: "merge" | "replace") => void;
}) {
  const [parsed, setParsed] = useState<ImportResult | null>(null);
  const [source, setSource] = useState("");
  const [message, setMessage] = useState("");
  const [pasteText, setPasteText] = useState("");

  function show(result: ImportResult, label: string) {
    const fileProblem = result.errors.find((error) => error.rowId === "");
    setParsed(fileProblem ? null : result);
    setSource(label);
    setMessage(fileProblem ? `Import rejected. ${fileProblem.message}` : "");
  }

  async function readFile(file: File) {
    setParsed(null);
    if (!file.name.toLowerCase().endsWith(".xlsx")) return setMessage("Import rejected. Choose an .xlsx workbook.");
    if (file.size > MAX_IMPORT_FILE_BYTES) return setMessage("Import rejected. The workbook is larger than 1 MB.");
    try {
      const sheets = await readXlsxFile(file);
      const sheet = sheets.find((item) => item.sheet === IMPORT_SHEET_NAME) ?? (sheets.length === 1 ? sheets[0] : undefined);
      if (!sheet) return setMessage(`Import rejected. The workbook needs a sheet named "${IMPORT_SHEET_NAME}".`);
      show(parseImportSheet(sheet.data), file.name);
    } catch {
      setMessage("Import rejected. This file is not a readable .xlsx workbook.");
    }
  }

  const imported = parsed?.rows ?? [];
  const importedIds = new Set(imported.map((row) => row.rowId));
  const relevant = (errors: EntryError[]) => errors.filter((error) => importedIds.has(error.rowId) || error.field === "rows");
  const mergeTooLong = currentRows.length + imported.length > MAX_IMPORT_ROWS;
  const cellErrors = parsed?.errors ?? [];
  const replaceErrors = parsed ? [...cellErrors, ...relevant(validate(imported))] : [];
  const mergeErrors = parsed && !draftIsBlank ? [...cellErrors, ...relevant(validate([...currentRows, ...imported]))] : replaceErrors;
  const shownErrors = draftIsBlank ? replaceErrors : mergeErrors;
  const rowMessages = (rowId: string) => [...new Set(shownErrors.filter((error) => error.rowId === rowId).map((error) =>
    error.message.startsWith("Row ") ? error.message : `Row ${parsed?.sheetRows[rowId]}: ${error.message}`))];

  function apply(mode: "merge" | "replace") {
    onApply(imported, mode);
    setParsed(null);
    setPasteText("");
    setMessage(`${imported.length} imported row${imported.length === 1 ? "" : "s"} added to the draft. Review the batch before saving.`);
  }

  return <div className={styles.importPanel}>
    <div className={styles.importControls}>
      <label>Import Excel (.xlsx)<input type="file" accept=".xlsx" disabled={disabled} onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void readFile(file);
      }} /></label>
      <button type="button" className={styles.secondary} onClick={() => void downloadTemplate()}>Download template</button>
    </div>
    <details>
      <summary>Paste rows copied from Excel</summary>
      <label>Cells in template column order<textarea aria-label="Paste rows" rows={3} disabled={disabled} value={pasteText} onChange={(event) => setPasteText(event.target.value)} /></label>
      <button type="button" className={styles.secondary} disabled={disabled || !pasteText.trim()} onClick={() => show(parsePastedRows(pasteText.replace(/\n+$/, "")), "pasted rows")}>Preview pasted rows</button>
    </details>
    {message && <p role={message.startsWith("Import rejected") ? "alert" : "status"}>{message}</p>}
    {parsed && <div className={styles.importPreview} role="region" aria-label="Import preview">
      <h3>Import preview — {imported.length} row{imported.length === 1 ? "" : "s"} from {source}</h3>
      <p>Not saved. Accepted rows join the draft and are saved only when you review and save the batch.</p>
      <div className={styles.importTable}><table><thead><tr><th scope="col">Row</th><th scope="col">Invoice number</th><th scope="col">Total QAR</th><th scope="col">Received QAR</th><th scope="col">Delivered</th><th scope="col">Customer</th><th scope="col">Note</th></tr></thead><tbody>
        {imported.map((row) => <tr key={row.rowId} data-import-row={row.rowId}>
          <td>{parsed.sheetRows[row.rowId]}</td><td>{row.invoiceId}</td><td>{row.total}</td><td>{row.received || "0"}</td>
          <td>{row.delivered ? "Yes" : "No"}</td><td>{[row.customerName, row.customerMobile].filter(Boolean).join(" · ")}</td><td>{row.note}</td>
        </tr>)}
      </tbody></table></div>
      {shownErrors.length > 0 && <ul className={styles.errors} aria-label="Import errors">
        {imported.flatMap((row) => rowMessages(row.rowId).map((text, index) => <li key={`${row.rowId}-${index}`}>{text}</li>))}
        {[...new Set(shownErrors.filter((error) => error.field === "rows").map((error) => error.message))].map((text) => <li key={text}>{text}</li>)}
      </ul>}
      {shownErrors.length > 0 && <p role="alert">Import blocked. Fix the workbook and import it again; no rows were added.</p>}
      {!draftIsBlank && mergeTooLong && <p role="alert">Adding these rows would exceed {MAX_IMPORT_ROWS} rows in one batch.</p>}
      <div className={styles.actions}>
        {draftIsBlank
          ? <button type="button" disabled={disabled || replaceErrors.length > 0} onClick={() => apply("replace")}>Add rows to draft</button>
          : <>
            <button type="button" disabled={disabled || mergeErrors.length > 0 || mergeTooLong} onClick={() => apply("merge")}>Add to current draft</button>
            <button type="button" className={styles.secondary} disabled={disabled || replaceErrors.length > 0} onClick={() => apply("replace")}>Replace current draft</button>
          </>}
        <button type="button" className={styles.secondary} onClick={() => { setParsed(null); setMessage(""); }}>Cancel import</button>
      </div>
    </div>}
  </div>;
}
