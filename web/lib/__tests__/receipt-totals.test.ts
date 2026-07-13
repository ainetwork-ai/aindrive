import { describe, it, expect } from "vitest";
import { sumByCurrency, formatCurrencyTotals } from "../receipt-totals";

describe("sumByCurrency", () => {
  it("groups amounts per currency instead of one meaningless cross-currency sum", () => {
    const totals = sumByCurrency([
      { amount_usdc: 1000, currency: "USDC" },
      { amount_usdc: 200, currency: "USDC" },
      { amount_usdc: 300, currency: "FANCO" },
    ]);
    expect(totals).toEqual([
      { currency: "USDC", total: 1200 },
      { currency: "FANCO", total: 300 },
    ]);
  });

  it("folds NULL currency into USDC and NULL amount into 0", () => {
    const totals = sumByCurrency([
      { amount_usdc: 50, currency: null },
      { amount_usdc: null, currency: "USDC" },
      { amount_usdc: 10, currency: "FANCO" },
    ]);
    expect(totals).toEqual([
      { currency: "USDC", total: 50 },
      { currency: "FANCO", total: 10 },
    ]);
  });

  it("orders by descending total", () => {
    const totals = sumByCurrency([
      { amount_usdc: 5, currency: "USDC" },
      { amount_usdc: 999, currency: "FANCO" },
    ]);
    expect(totals.map((t) => t.currency)).toEqual(["FANCO", "USDC"]);
  });

  it("returns [] for no receipts", () => {
    expect(sumByCurrency([])).toEqual([]);
  });
});

describe("formatCurrencyTotals", () => {
  it("renders grouped totals with a separator", () => {
    expect(
      formatCurrencyTotals([
        { currency: "USDC", total: 1200 },
        { currency: "FANCO", total: 300 },
      ])
    ).toBe("1,200 USDC · 300 FANCO");
  });

  it("shows 0 USDC when there are no sales", () => {
    expect(formatCurrencyTotals([])).toBe("0 USDC");
  });
});
