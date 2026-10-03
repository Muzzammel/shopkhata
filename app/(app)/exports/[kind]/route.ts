import type { NextRequest } from "next/server";
import writeXlsxFile from "write-excel-file/universal";
import { z } from "zod";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import {
  MAX_EXPORT_ROWS, expenseExportSheet, fetchExpenseExport, fetchInvoiceExport, fetchLedgerExport,
  invoiceExportSheet, ledgerExportSheet, type ExportSheet,
} from "@/lib/excel/exports";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const rangeSchema = z.object({ shop: z.uuid(), from: z.iso.date(), to: z.iso.date() }).refine((value) => value.from <= value.to);
const ledgerSchema = z.object({ shop: z.uuid(), customer: z.uuid() });

const fail = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, context: RouteContext<"/exports/[kind]">) {
  const { kind } = await context.params;
  const query = Object.fromEntries(request.nextUrl.searchParams);
  let actor: Actor;
  try { actor = await getCurrentActor(); } catch { return fail(401, "Sign in to export records."); }

  let sheet: ExportSheet;
  let fileName: string;
  try {
    const supabase = await createServerSupabaseClient();
    if (kind === "customer-ledger") {
      const parsed = ledgerSchema.safeParse(query);
      if (!parsed.success) return fail(400, "Choose a customer to export.");
      if (!can(actor, "records.export", parsed.data.shop)) return fail(403, "You cannot export records for this shop.");
      const ledger = await fetchLedgerExport(supabase, parsed.data.shop, parsed.data.customer);
      if (!ledger) return fail(404, "Customer not found in this shop.");
      sheet = ledgerExportSheet(ledger.sources);
      fileName = `shopkhata-ledger-${ledger.customer}`;
    } else if (kind === "invoices" || kind === "expenses") {
      const today = qatarBusinessDate(new Date());
      const parsed = rangeSchema.safeParse({ shop: query.shop, from: query.from || today, to: query.to || today });
      if (!parsed.success) return fail(400, "Choose a valid date range.");
      const { shop, from, to } = parsed.data;
      if (!can(actor, "records.export", shop)) return fail(403, "You cannot export records for this shop.");
      sheet = kind === "invoices"
        ? invoiceExportSheet(await fetchInvoiceExport(supabase, shop, from, to))
        : expenseExportSheet(await fetchExpenseExport(supabase, shop, from, to));
      fileName = `shopkhata-${kind}-${from}_${to}`;
    } else {
      return fail(404, "Unknown export.");
    }
  } catch {
    return fail(503, "The export could not be prepared. Try again.");
  }
  if (sheet.data.length - 1 > MAX_EXPORT_ROWS) return fail(413, "Too many rows for one export. Choose a shorter date range.");

  return new Response(await writeXlsxFile([sheet]).toBlob(), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
