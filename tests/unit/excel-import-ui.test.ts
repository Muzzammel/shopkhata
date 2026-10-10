// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ExcelImport } from "@/app/(app)/excel-import";
import type { EntryRow } from "@/lib/invoice-entry";

afterEach(cleanup);

function preview(pasted: string) {
  const onApply = vi.fn<(rows: EntryRow[], mode: "merge" | "replace") => void>();
  render(createElement(ExcelImport, { disabled: false, currentRows: [], draftIsBlank: true, validate: () => [], onApply }));
  fireEvent.change(screen.getByLabelText("Paste rows"), { target: { value: pasted } });
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted rows" }));
  return { onApply, region: within(screen.getByRole("region", { name: "Import preview" })) };
}

describe("Excel import preview", () => {
  it("is all-or-nothing: one invalid row blocks every row, including the valid ones", () => {
    const { onApply, region } = preview("OK-1\t10\t0\tYes\t\t\t\nBAD-2\t10\t0\tmaybe\t\t\t\nOK-3\t10\t0\tNo\t\t\t");
    const add = region.getByRole("button", { name: "Add rows to draft" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(onApply).not.toHaveBeenCalled();
    expect(region.getByRole("alert").textContent).toContain("Import blocked");
    expect(region.getByRole("alert").textContent).toContain("no rows were added");
  });

  it("names the row, column, received value and accepted values, and highlights only the invalid cell", () => {
    const { region } = preview("OK-1\t10\t0\tYes\t\t\t\nBAD-2\t10\t0\tmaybe\t\t\t");
    const problem = within(region.getByRole("list", { name: "Import errors" })).getByRole("listitem");
    expect(problem.textContent).toContain("Row 3: Delivered must be Yes or No.");
    expect(problem.textContent).toContain("Column: Delivered");
    expect(problem.textContent).toContain('Received: "maybe"');
    expect(problem.textContent).toContain("Expected: Yes or No (any letter case), TRUE or FALSE, or blank for No");
    const invalid = document.querySelectorAll('[aria-invalid="true"]');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].getAttribute("data-import-cell")).toBe("delivered");
    // The cell shows what the workbook held, not the "No" the draft row would have defaulted to.
    expect(invalid[0].textContent).toBe('"maybe"');
  });

  it("applies every row when all are valid", () => {
    const { onApply, region } = preview("OK-1\t10\t0\t yes \t\t\t\nOK-2\t10\t0\tNO\t\t\t");
    expect(region.queryByRole("list", { name: "Import errors" })).toBeNull();
    fireEvent.click(region.getByRole("button", { name: "Add rows to draft" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].map((row) => row.delivered)).toEqual([true, false]);
    expect(onApply.mock.calls[0][1]).toBe("replace");
  });
});
