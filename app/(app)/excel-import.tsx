"use client";

import { useState } from "react";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";

import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  IMPORT_FIELD_COLUMN, IMPORT_SHEET_NAME, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, importTemplateSheets, parseImportSheet, parsePastedRows,
  type ImportCellError, type ImportResult,
} from "@/lib/excel/invoice-import";
import type { EntryError, EntryRow } from "@/lib/invoice-entry";

import styles from "@/app/ui.module.css";

const PREVIEW_FIELDS = ["invoiceId", "total", "received", "delivered", "customer", "note"] as const;
const draftValue = (row: EntryRow, field: string) => field === "invoiceId" ? row.invoiceId : field === "total" ? row.total : field === "received" ? row.received || "0"
  : field === "delivered" ? (row.delivered ? "Yes" : "No") : field === "customer" ? [row.customerName, row.customerMobile].filter(Boolean).join(" · ") : field === "note" ? row.note : "";
const isCellError = (error: EntryError): error is ImportCellError => "received" in error;

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
export function ExcelImport({ disabled, currentRows, draftIsBlank, validate, onApply, onPreview }: {
  disabled: boolean;
  currentRows: EntryRow[];
  draftIsBlank: boolean;
  /** The same batch validation manual rows get. */
  validate: (rows: EntryRow[]) => EntryError[];
  onApply: (rows: EntryRow[], mode: "merge" | "replace") => void;
  /** The rows under preview, so their invoice numbers get the duplicate check before they join the draft. */
  onPreview?: (rows: EntryRow[]) => void;
}) {
  const [parsed, setParsedState] = useState<ImportResult | null>(null);
  const [source, setSource] = useState("");
  const [message, setMessage] = useState("");
  const [pasteText, setPasteText] = useState("");

  function setParsed(result: ImportResult | null) {
    setParsedState(result);
    onPreview?.(result?.rows ?? []);
  }

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
  // One entry per distinct problem: where it is, what the workbook held there, and what is accepted.
  const problems = imported.flatMap((row) => {
    const seen = new Set<string>();
    return shownErrors.filter((error) => error.rowId === row.rowId).flatMap((error) => {
      const text = error.message.startsWith("Row ") ? error.message : `Row ${parsed?.sheetRows[row.rowId]}: ${error.message}`;
      if (seen.has(text)) return [];
      seen.add(text);
      return [isCellError(error)
        ? { key: `${row.rowId}:${error.field}`, text, column: error.column, received: error.received, expected: error.expected }
        : { key: `${row.rowId}:${error.field}`, text, column: IMPORT_FIELD_COLUMN[error.field] ?? error.field, received: JSON.stringify(draftValue(row, error.field)), expected: null }];
    });
  });
  const invalidCells = new Set(problems.map((problem) => problem.key));
  // A cell that could not be read shows what the workbook held, not the placeholder the draft row got.
  const unreadable = new Map<string, string>();
  for (const error of cellErrors) if (isCellError(error)) unreadable.set(`${error.rowId}:${error.field}`, [unreadable.get(`${error.rowId}:${error.field}`), error.received].filter(Boolean).join(" · "));

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
    {message && (message.startsWith("Import rejected")
      ? <Alert variant="destructive" className="border-destructive/50 bg-danger-soft"><CircleAlertIcon /><AlertTitle>Import rejected</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
      : <p role="status">{message}</p>)}
    {parsed && <div className={styles.importPreview} role="region" aria-label="Import preview">
      <h3>Import preview — {imported.length} row{imported.length === 1 ? "" : "s"} from {source}</h3>
      <p>Not saved. Accepted rows join the draft and are saved only when you review and save the batch.</p>
      <div className={styles.importTable}><Table>
        <TableHeader><TableRow><TableHead scope="col">Row</TableHead><TableHead scope="col">Invoice number</TableHead><TableHead scope="col">Total QAR</TableHead><TableHead scope="col">Received QAR</TableHead><TableHead scope="col">Delivered</TableHead><TableHead scope="col">Customer</TableHead><TableHead scope="col">Note</TableHead></TableRow></TableHeader>
        <TableBody>{imported.map((row) => <TableRow key={row.rowId} data-import-row={row.rowId}>
          <TableCell aria-invalid={invalidCells.has(`${row.rowId}:row`) || undefined} className="aria-invalid:bg-danger-soft aria-invalid:font-semibold aria-invalid:text-destructive">{parsed.sheetRows[row.rowId]}</TableCell>
          {PREVIEW_FIELDS.map((field) => <TableCell key={field} data-import-cell={field} aria-invalid={invalidCells.has(`${row.rowId}:${field}`) || undefined}
            className="aria-invalid:bg-danger-soft aria-invalid:font-semibold aria-invalid:text-destructive aria-invalid:outline aria-invalid:-outline-offset-1 aria-invalid:outline-destructive">
            {unreadable.get(`${row.rowId}:${field}`) ?? draftValue(row, field)}
          </TableCell>)}
        </TableRow>)}</TableBody>
      </Table></div>
      {shownErrors.length > 0 && <Alert variant="destructive" className="border-destructive/50 bg-danger-soft">
        <CircleAlertIcon /><AlertTitle>Import blocked</AlertTitle>
        <AlertDescription>Fix the highlighted cells in the workbook and import it again; no rows were added.</AlertDescription>
      </Alert>}
      {shownErrors.length > 0 && <ul className="grid list-none gap-2 pl-0" aria-label="Import errors">
        {problems.map((problem, index) => <li key={`${problem.key}-${index}`} className="grid gap-0.5 border-l-2 border-destructive pl-3 text-sm">
          <strong className="font-semibold text-destructive">{problem.text}</strong>
          <span className="text-muted-foreground">Column: {problem.column} · Received: <code>{problem.received}</code>{problem.expected && <> · Expected: {problem.expected}</>}</span>
        </li>)}
        {[...new Set(shownErrors.filter((error) => error.field === "rows").map((error) => error.message))].map((text) => <li key={text} className="border-l-2 border-destructive pl-3 text-sm font-semibold text-destructive">{text}</li>)}
      </ul>}
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
