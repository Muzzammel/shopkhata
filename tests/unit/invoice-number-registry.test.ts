import { describe, expect, it } from "vitest";

import { findRegisteredInvoiceNumbers } from "@/lib/invoice-number-registry";

type Call = { method: string; args: unknown[] };

/** Records every query-builder call; each awaited query answers with `answer(calls)`. */
function fakeClient(answer: (calls: Call[]) => { data: unknown; error: unknown }) {
  const queries: Call[][] = [];
  const client = {
    from(table: string) {
      const calls: Call[] = [{ method: "from", args: [table] }];
      queries.push(calls);
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => void) => resolve(answer(calls)),
      };
      for (const method of ["select", "eq", "filter", "in", "order", "range", "limit"]) {
        builder[method] = (...args: unknown[]) => { calls.push({ method, args }); return builder; };
      }
      return builder;
    },
  };
  return { client: client as never, queries };
}

describe("findRegisteredInvoiceNumbers", () => {
  it("asks only for the normalized numbers given, by exact shop and number, never by paging", async () => {
    const { client, queries } = fakeClient(() => ({ data: [{ normalized_invoice_number: "inv-1" }], error: null }));
    expect(await findRegisteredInvoiceNumbers(client, "shop-1", [" INV-1 ", "inv-1", "", "Inv-2"])).toEqual(["inv-1"]);
    expect(queries).toEqual([[
      { method: "from", args: ["invoice_number_registry"] },
      { method: "select", args: ["normalized_invoice_number"] },
      { method: "eq", args: ["shop_id", "shop-1"] },
      { method: "filter", args: ["normalized_invoice_number", "in", '("inv-1","inv-2")'] },
    ]]);
  });

  it("stays bounded by the numbers asked about: a full 100-row batch is five requests", async () => {
    const { client, queries } = fakeClient(() => ({ data: [], error: null }));
    await findRegisteredInvoiceNumbers(client, "shop-1", Array.from({ length: 100 }, (_, i) => `N-${i}`));
    expect(queries).toHaveLength(5);
    expect(queries.flat().some((call) => ["range", "order"].includes(call.method))).toBe(false);
  });

  it("quotes and escapes numbers so commas, quotes and backslashes stay one value", async () => {
    const { client, queries } = fakeClient(() => ({ data: [], error: null }));
    await findRegisteredInvoiceNumbers(client, "shop-1", ['a,b', 'q"x', "b\\s", "(p)"]);
    expect(queries[0][3].args[2]).toBe('("a,b","q\\"x","b\\\\s","(p)")');
  });

  it("makes no request when there is nothing to check", async () => {
    const { client, queries } = fakeClient(() => ({ data: [], error: null }));
    expect(await findRegisteredInvoiceNumbers(client, "shop-1", ["", "  "])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("reports a failed lookup as unknown, never as available", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }));
    expect(await findRegisteredInvoiceNumbers(client, "shop-1", ["INV-1"])).toBeNull();
  });
});
