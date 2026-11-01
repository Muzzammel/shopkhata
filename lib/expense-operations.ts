import { z } from "zod";
import { parseQar } from "@/lib/domain/money";
import { SHOP_INACTIVE_MESSAGE } from "@/lib/shop-admin";

export const EXPENSE_CATEGORIES = ["rent", "utilities", "supplies", "transport", "maintenance", "other"] as const;
const categorySchema = z.enum(EXPENSE_CATEGORIES);

export type ExpenseInput = { amountDirham: number; category: (typeof EXPENSE_CATEGORIES)[number]; description: string };

export function prepareExpenseInput(input: { amount: string; category: string; description: string }): { command: ExpenseInput | null; error: string | null } {
  let amountDirham: number;
  try { amountDirham = parseQar(input.amount.trim()); }
  catch { return { command: null, error: "Enter a positive QAR amount with up to two decimal places." }; }
  if (amountDirham <= 0) return { command: null, error: "Enter a positive QAR amount with up to two decimal places." };
  const category = categorySchema.safeParse(input.category);
  const description = input.description.trim();
  if (!category.success || description.length < 1 || description.length > 1000 || !Number.isSafeInteger(amountDirham)) {
    return { command: null, error: "Check the expense amount, category, and description." };
  }
  return { command: { amountDirham, category: category.data, description }, error: null };
}

export function expenseOperationError(code: string): string {
  switch (code) {
    case "INSUFFICIENT_ROLE": return "Only a manager or owner can decide expense corrections.";
    case "42501": return "You are not authorized for this expense operation.";
    case "UNAUTHORIZED_SHOP": return "You cannot access expenses for this shop.";
    case "INVALID_DATE": return "Choose a valid business date.";
    case "SHOP_INACTIVE": return SHOP_INACTIVE_MESSAGE;
    case "CLOSED_DATE": return "This business date is closed. Reopen it before recording a new expense.";
    case "STALE_CORRECTION": return "This expense was corrected after the request was submitted. Review the current amount and request again.";
    case "IDEMPOTENCY_CONFLICT": return "This retry key was already used for a different expense request.";
    default: return "Expense operation could not be completed.";
  }
}
