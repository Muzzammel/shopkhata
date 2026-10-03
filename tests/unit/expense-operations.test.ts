import { describe, expect, it } from "vitest";
import { prepareExpenseInput, expenseOperationError } from "@/lib/expense-operations";

describe("expense command input", () => {
  it("normalizes a valid expense to integer dirham and a fixed category", () => {
    expect(prepareExpenseInput({ amount: "14.25", category: "utilities", description: "  Water bill  " })).toEqual({ command: { amountDirham: 1425, category: "utilities", description: "Water bill" }, error: null });
  });
  it("rejects fractional dirham, empty descriptions, and unapproved categories", () => {
    expect(prepareExpenseInput({ amount: "1.001", category: "rent", description: "Rent" }).error).toBe("Enter a positive QAR amount with up to two decimal places.");
    expect(prepareExpenseInput({ amount: "1.00", category: "payroll", description: "Rent" }).command).toBeNull();
    expect(prepareExpenseInput({ amount: "1.00", category: "rent", description: "   " }).command).toBeNull();
  });
  it("maps known and unknown database failures to fixed user messages", () => {
    expect(expenseOperationError("STALE_CORRECTION")).toBe("This expense was corrected after the request was submitted. Review the current amount and request again.");
    expect(expenseOperationError("42501")).toBe("You are not authorized for this expense operation.");
    expect(expenseOperationError("CLOSED_DATE")).toBe("This business date is closed. Reopen it before recording a new expense.");
    expect(expenseOperationError("some raw SQL detail")).toBe("Expense operation could not be completed.");
  });
});
