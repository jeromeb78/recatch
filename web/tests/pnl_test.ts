import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { buildPnl, costBasis, expenseAmount, onHand, type PBuyLine, type POrder, type PSaleLine } from "../src/lib/pnl.ts";

const buy = (o: Partial<PBuyLine>): PBuyLine => ({
  id: crypto.randomUUID(), description: "Item", woo_sku: null, units: 1, landed_total: 0, tax_line: null, use_type: null,
  business_pct: null, purchase_date: "2026-03-01", ...o,
});
const order = (o: Partial<POrder>): POrder => ({
  id: crypto.randomUUID(), order_date: "2026-04-10", status: "paid", items_total: 0, shipping_charged: 0, tax_collected: 0,
  refunded: 0, fees: 0, channel_id: "c", ...o,
});

const buys = [
  buy({ woo_sku: "hw-1", description: "Camaro", units: 10, landed_total: 12, purchase_date: "2025-11-02" }), // last year still counts for cost
  buy({ woo_sku: "HW-1", description: "Camaro 67", units: 10, landed_total: 18, purchase_date: "2026-02-01" }),
  buy({ woo_sku: "HW-2", units: 4, landed_total: 20, purchase_date: "2026-12-30" }), // after the period: not in basis
  buy({ woo_sku: "BOX", units: 2, landed_total: 10, purchase_date: "2026-01-05" }),
];
const o1 = order({ items_total: 40, shipping_charged: 5, tax_collected: 3, fees: 1.6, refunded: 4 });
const o2 = order({ order_date: "2026-05-02", status: "refunded", items_total: 10, refunded: 10, fees: 0.6 });
const o3 = order({ status: "cancelled", items_total: 99 });
const o4 = order({ order_date: "2025-12-31", items_total: 50 }); // outside period
const lines: PSaleLine[] = [
  { order_id: o1.id, sku: "HW-1", name: "Camaro", quantity: 4, total: 20 },
  { order_id: o1.id, sku: null, name: "Mystery", quantity: 1, total: 20 },
  { order_id: o2.id, sku: "HW-1", name: "Camaro", quantity: 2, total: 10 },
  { order_id: o3.id, sku: "HW-1", name: "Camaro", quantity: 9, total: 99 },
  { order_id: o4.id, sku: "HW-1", name: "Camaro", quantity: 3, total: 50 },
];

Deno.test("cost basis averages landed cost across years, up to the as-of date", () => {
  const b = costBasis(buys, "2026-06-30");
  assertEquals(b.get("HW-1")?.units, 20);
  assertAlmostEquals(b.get("HW-1")!.unit, 1.5);
  assertEquals(b.get("HW-1")?.name, "Camaro 67");
  assertEquals(b.has("HW-2"), false);
});

Deno.test("profit and loss", () => {
  const expenses = [
    buy({ tax_line: "c22", landed_total: 15, purchase_date: "2026-04-01" }),
    buy({ tax_line: "c24b", landed_total: 40, purchase_date: "2026-04-01" }), // meals 50%
    buy({ tax_line: "c18", use_type: "mixed", business_pct: 25, landed_total: 100, purchase_date: "2026-04-01" }),
    buy({ tax_line: "personal", landed_total: 500, purchase_date: "2026-04-01" }),
    buy({ tax_line: "cogs", landed_total: 300, purchase_date: "2026-04-01" }), // inventory: costed when sold
    buy({ tax_line: "c22", landed_total: 7, purchase_date: "2025-04-01" }), // other year
  ];
  const p = buildPnl({
    from: "2026-01-01", to: "2026-12-31", orders: [o1, o2, o3, o4], saleLines: lines,
    inventoryBuys: buys, periodBuys: expenses, trips: [{ trip_date: "2026-04-03", miles: 10 }],
  });
  assertEquals(p.orders, 2);
  assertEquals(p.gross, 55); // 45 + 10
  assertEquals(p.returns, 14);
  assertEquals(p.netSales, 41);
  assertEquals(p.taxCollected, 3);
  assertEquals(p.fees, 2.2);
  // 4 Camaros at the average 1.5 each (HW-2 is in the basis but unsold)
  assertEquals(p.cogs, 6);
  assertEquals(p.units, 5);
  assertEquals(p.expenses.map((e) => [e.line, e.amount]), [["c18", 25], ["c24b", 20], ["c22", 15]]);
  assertEquals(p.expenseTotal, 60);
  assertEquals(p.mileage > 6 && p.mileage < 8, true);
  assertEquals(p.profit, Math.round((41 - 6 - 2.2 - 60 - p.mileage) * 100) / 100);
  assertEquals(p.unmatched, [{ key: "name:mystery", sku: null, name: "Mystery", units: 1, revenue: 20 }]);
  const camaro = p.products.find((x) => x.sku === "HW-1")!;
  assertEquals([camaro.units, camaro.revenue, camaro.cost, camaro.profit], [4, 20, 6, 14]);
  assertAlmostEquals(camaro.margin!, 0.7);
  assertEquals(p.months.map((m) => m.month), ["2026-04", "2026-05"]);
  assertEquals(p.months[1].sales, 0); // fully refunded
});

Deno.test("expense amount ignores inventory, personal and uncategorized", () => {
  assertEquals(expenseAmount(buy({ woo_sku: "X", tax_line: "c22", landed_total: 5 })), null);
  assertEquals(expenseAmount(buy({ tax_line: null, landed_total: 5 })), null);
  assertEquals(expenseAmount(buy({ tax_line: "c22", use_type: "mixed", landed_total: 5 })), null); // no % set yet
  assertEquals(expenseAmount(buy({ tax_line: "c22", landed_total: 5 })), 5);
});

Deno.test("inventory on hand", () => {
  const r = onHand({ asOf: "2026-12-31", inventoryBuys: buys, orders: [o1, o2, o3, o4], saleLines: lines, storeStock: new Map([["HW-1", 12]]) });
  const hw1 = r.rows.find((x) => x.sku === "HW-1")!;
  assertEquals([hw1.bought, hw1.sold, hw1.onHand, hw1.storeStock], [20, 7, 13, 12]); // 4 (o1) + 3 (o4); refunded/cancelled don't count
  assertAlmostEquals(hw1.value, 19.5);
  assertEquals(r.rows.find((x) => x.sku === "HW-2")?.onHand, 4);
  assertEquals(r.value, 19.5 + 20 + 10);
});
