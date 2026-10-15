import { assertEquals } from "jsr:@std/assert@1";
import { categoryStats } from "../src/lib/categoryStats.ts";
import type { ALine, AReceipt } from "../src/lib/analytics.ts";

const rc = (o: Partial<AReceipt>): AReceipt => ({ id: crypto.randomUUID(), merchant: "Store", purchase_date: "2026-05-01", total: 0, document_type: "receipt", status: "ready", ...o });
const line = (o: Partial<ALine>): ALine => ({
  id: crypto.randomUUID(), receipt_id: "", description: "x", woo_sku: null, store_sku: null, quantity: 1, units: 1, landed_total: 0,
  tax_line: null, use_type: null, business_pct: null, merchant: "Store", purchase_date: "2026-05-01", ...o,
} as ALine);
const cats = [
  { id: "inv", name: "Inventory (COGS)", is_business: true, color: "#123" },
  { id: "ship", name: "Shipping Supplies", is_business: true },
  { id: "groc", name: "Groceries", is_business: false },
  { id: "med", name: "health/medical expenses", is_business: false },
  { id: "unused", name: "Household", is_business: false },
];

Deno.test("spend, write-offs by tax line and Schedule A notes per category", () => {
  const a = rc({ category_id: "inv", total: 120 }), b = rc({ category_id: "ship", total: 40 }), g = rc({ category_id: "groc", total: 80 });
  const m = rc({ category_id: "med", total: 55 }), n = rc({ category_id: null, total: 9 }), refund = rc({ category_id: "inv", total: 20, document_type: "refund" });
  const stats = categoryStats({
    categories: cats,
    receipts: [a, b, g, m, n, refund],
    prevReceipts: [rc({ category_id: "inv", total: 50 }), rc({ category_id: "unused", total: 5 })],
    lines: [
      line({ receipt_id: a.id, tax_line: "cogs", use_type: "business", landed_total: 100 }),
      line({ receipt_id: b.id, tax_line: "c22", use_type: "business", landed_total: 30 }),
      line({ receipt_id: b.id, tax_line: "c18", use_type: "mixed", business_pct: 50, landed_total: 10 }),
      line({ receipt_id: g.id, tax_line: "personal", use_type: "personal", landed_total: 70 }),
      line({ receipt_id: g.id, tax_line: "c22", use_type: "business", landed_total: 6 }), // business item on a grocery run
      line({ receipt_id: m.id, tax_line: "personal", use_type: "personal", landed_total: 55 }),
    ],
  });
  const by = Object.fromEntries(stats.map((s) => [s.id, s]));
  assertEquals(stats.map((s) => s.id), ["inv", "ship", "groc", "med", "none"]); // business first, then by spend; unused category has no card
  assertEquals([by.inv.spend, by.inv.receipts, by.inv.prevSpend, by.inv.color], [100, 2, 50, "#123"]);
  assertEquals(by.inv.writeOffs.map((w) => [w.line, w.amount]), [["cogs", 100]]);
  assertEquals([by.ship.writeOffTotal, by.ship.writeOffs.map((w) => w.line)], [35, ["c22", "c18"]]);
  assertEquals([by.groc.writeOffTotal, by.groc.personalNote], [6, null]);
  assertEquals([by.med.writeOffTotal, by.med.personalNote?.amount], [0, 55]);
  assertEquals(by.none.name, "No category");
});
