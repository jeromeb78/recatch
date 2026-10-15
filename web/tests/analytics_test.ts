// deno test --sloppy-imports web/tests
import { assert, assertEquals } from "jsr:@std/assert@1";
import { byMonth, change, classify, itemKey, itemStats, kpis, periodRange, storeKey, storeStats, type ALine, type AReceipt } from "../src/lib/analytics.ts";

const R = (id: string, merchant: string, date: string, total: number, extra: Partial<AReceipt> = {}): AReceipt =>
  ({ id, merchant, purchase_date: date, total, document_type: "receipt", status: "ready", ...extra });
const L = (id: string, rid: string, desc: string, total: number, extra: Partial<ALine> = {}): ALine => ({
  id, receipt_id: rid, description: desc, woo_sku: null, store_sku: null, quantity: 1, units: 1, landed_total: total,
  tax_line: "cogs", use_type: "business", business_pct: null, merchant: "Walmart", purchase_date: "2026-08-14", ...extra,
});

const receipts = [
  R("a", "Walmart", "2026-08-14", 60),
  R("b", "WALMART.COM", "2026-09-02", 30),
  R("c", "Target", "2026-10-01", 25),
  R("d", "Target", "2026-10-03", 10, { document_type: "refund" }),
];
const lines = [
  L("1", "a", "Hot Wheels 5-Pack", 40, { units: 5 }),
  L("2", "a", "Paper towels", 20, { tax_line: "personal", use_type: "personal" }),
  L("3", "b", "Hot Wheels 5-pack", 30, { units: 5, purchase_date: "2026-09-02", merchant: "WALMART.COM" }),
  L("4", "c", "Shipping tape", 10, { tax_line: "c22", use_type: "mixed", business_pct: 80, merchant: "Target", purchase_date: "2026-10-01" }),
];

Deno.test("classify: inventory, personal, mixed split, unsorted", () => {
  assertEquals(classify({ tax_line: "cogs", use_type: "business", business_pct: null }), [["inventory", 1]]);
  assertEquals(classify({ tax_line: "c22", use_type: "mixed", business_pct: 80 }), [["business", 0.8], ["personal", 0.19999999999999996]]);
  assertEquals(classify({ tax_line: null, use_type: null, business_pct: null }), [["unsorted", 1]]);
});

Deno.test("kpis: refunds subtract, un-itemised spend is unsorted, mixed split", () => {
  const k = kpis(receipts, lines);
  assertEquals(k.spend, 105); // 60 + 30 + 25 − 10
  assertEquals(k.receipts, 3);
  assertEquals(k.avgOrder, 38.33);
  assertEquals(k.byKind.inventory, 70);
  assertEquals(k.byKind.business, 8);
  assertEquals(k.byKind.personal, 22);
  assertEquals(k.stores, 2); // Walmart and WALMART.COM are one store
  assertEquals(change(120, 100), 20);
  assertEquals(change(5, 0), null);
});

Deno.test("byMonth fills gaps and keeps months in order", () => {
  const m = byMonth([R("x", "W", "2026-06-10", 10), R("y", "W", "2026-09-01", 5)], []);
  assertEquals(m.map((r) => r.month), ["2026-06", "2026-07", "2026-08", "2026-09"]);
  assertEquals(m[0].byKind.unsorted, 10);
  assertEquals(m[1].total, 0);
});

Deno.test("stores merge spellings and rank by spend", () => {
  assertEquals(storeKey("Walmart.com"), storeKey("WALMART"));
  const s = storeStats(receipts, lines);
  assertEquals(s[0].name, "Walmart");
  assertEquals(s[0].spend, 90);
  assertEquals(s[0].orders, 2);
  assertEquals(s[0].lastVisit, "2026-09-02");
  assertEquals(s[0].topItems[0].name, "Hot Wheels 5-Pack");
  assertEquals(s[0].topItems[0].count, 2);
  assertEquals(s[1].orders, 1); // the refund isn't an order
});

Deno.test("items merge across receipts with unit costs and cheapest store", () => {
  assertEquals(itemKey({ woo_sku: null, store_sku: null, description: "Hot Wheels® 5-Pack " }), itemKey({ woo_sku: null, store_sku: null, description: "hot wheels 5-pack" }));
  const items = itemStats(lines);
  const hw = items.find((i) => i.name.toLowerCase().startsWith("hot wheels"))!;
  assertEquals(hw.purchases, 2);
  assertEquals(hw.units, 10);
  assertEquals(hw.avgUnit, 7);
  assertEquals(hw.lowUnit, 6);
  assertEquals(hw.lowStore, "WALMART.COM");
  assertEquals(hw.lastBought, "2026-09-02");
  assertEquals(hw.kind, "inventory");
});

Deno.test("periods: previous range has the same shape", () => {
  const p = periodRange("month", new Date(2026, 9, 15));
  assertEquals([p.from, p.to, p.prev?.from, p.prev?.to], ["2026-10-01", "2026-10-15", "2026-09-01", "2026-09-15"]);
  const y = periodRange("lastyear", new Date(2026, 9, 15));
  assertEquals([y.from, y.to, y.prev?.from], ["2025-01-01", "2025-12-31", "2024-01-01"]);
  assert(periodRange("all").prev === null);
});

Deno.test("an item's stores are listed once per store", () => {
  const items = itemStats(lines);
  const hw = items.find((i) => i.name.toLowerCase().startsWith("hot wheels"))!;
  assertEquals(hw.stores.length, 1);
});
