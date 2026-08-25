import { describe, expect, it } from "vitest";

import { formatQar, parseQar } from "@/lib/domain/money";

describe("QAR money", () => {
  it("parses riyals and fils into integer dirhams", () => {
    expect(parseQar("125.50")).toBe(12550);
    expect(parseQar("0.01")).toBe(1);
  });

  it("rejects unsupported precision instead of rounding", () => {
    expect(() => parseQar("12.345")).toThrow("AMOUNT_PRECISION");
  });

  it("formats integer dirhams with exactly two decimal places", () => {
    expect(formatQar(12550)).toBe("125.50");
  });
});
