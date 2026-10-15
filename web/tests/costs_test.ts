import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { costResolver, matches, parseSkuCosts, poolStats, suggestPools, type CostPool } from "../src/lib/costs.ts";
import { buildPnl, costBasis, onHand, type PBuyLine, type POrder, type PSaleLine } from "../src/lib/pnl.ts";

const buy = (o: Partial<PBuyLine>): PBuyLine => ({
  id: crypto.randomUUID(), description: "Item", woo_sku: null, units: 1, landed_total: 0, tax_line: "cogs", use_type: "business",
  business_pct: null, purchase_date: "2026-03-01", ...o,
});
const pools: CostPool[] = [
  { id: "cc", name: "Car Culture", purchase_words: ["car culture"], product_words: ["car culture"], unit_cost: null, position: 0 },
  { id: "hw", name: "Hot Wheels mainline", purchase_words: ["hot wheels"], product_words: ["hot wheels"], unit_cost: null, position: 1 },
  { id: "m2", name: "M2", purchase_words: ["m2"], product_words: ["m2 machines"], unit_cost: 9.5, position: 2 },
];
const buys = [
  buy({ description: "Hot Wheels Car Culture Master", units: 10, landed_total: 70 }),
  buy({ description: "Hot Wheels Single Pack – (Styles May Vary)", units: 20, landed_total: 25 }),
  buy({ description: "HotWheels basic car", units: 5, landed_total: 7.5 }),
  buy({ description: "Hot Wheels Car Culture tagged", woo_sku: "HCJ85", units: 2, landed_total: 16 }), // tagged: not in pools
  buy({ description: "Hot Wheels Single Pack later", units: 10, landed_total: 100, purchase_date: "2027-01-01" }), // after asOf
];

Deno.test("phrase matching", () => {
  assertEquals(matches("Hot Wheels 2022 Car Culture Jay Leno's Garage", ["car culture"]), true);
  assertEquals(matches("HotWheels single", ["hot wheels"]), true);
  assertEquals(matches("Matchbox car", ["hot wheels", "car culture"]), false);
});

Deno.test("pool costs come from untagged purchases, first matching pool wins", () => {
  const s = poolStats(pools, buys, "2026-12-31");
  assertEquals([s.get("cc")!.units, s.get("cc")!.unit], [10, 7]);
  assertEquals([s.get("hw")!.units, s.get("hw")!.spend, s.get("hw")!.purchases], [25, 32.5, 2]);
  assertAlmostEquals(s.get("hw")!.unit!, 1.3);
  assertEquals([s.get("m2")!.avg, s.get("m2")!.unit], [null, 9.5]); // set by hand, no purchases needed
});

Deno.test("most specific cost wins: yours → store → receipts → pinned pool → matching pool", () => {
  const cost = costResolver({
    pools, stats: poolStats(pools, buys, "2026-12-31"), receiptBasis: costBasis(buys, "2026-12-31"),
    skuCosts: [{ sku: "GJP91", unit_cost: 12, pool_id: null }, { sku: "PIN1", unit_cost: null, pool_id: "m2" }, { sku: "HCJ85", unit_cost: null, pool_id: null }],
    storeProducts: [
      { sku: "GJP91", name: "Hot Wheels 2020 Car Culture Thrill Climbers", cost: 3 },
      { sku: "STORE1", name: "Hot Wheels Car Culture X", cost: "4.25" },
      { sku: "XYZ", name: "Hot Wheels 2026 Silver Series Porsche", cost: null },
    ],
  });
  assertEquals(cost("gjp91", "x"), { unit: 12, source: "manual", label: "Your cost" });
  assertEquals(cost("STORE1", "x")?.source, "store");
  assertEquals(cost("HCJ85", "Car Culture")?.source, "receipts"); // tagged receipts beat the pool
  assertEquals(cost("PIN1", "Hot Wheels thing"), { unit: 9.5, source: "pool", poolId: "m2", label: "M2" });
  assertEquals(cost("XYZ", "Porsche")?.poolId, "hw"); // matched by the store's catalog name
  assertEquals(cost(null, "Hot Wheels Car Culture Deora")?.poolId, "cc");
  assertEquals(cost("NOPE", "Greenlight Ford"), null);
});

Deno.test("profit and on-hand use pools, and a SKU cost swaps in when set", () => {
  const order: POrder = { id: "o1", order_date: "2026-05-01", status: "paid", items_total: 30, shipping_charged: 0, tax_collected: 0, refunded: 0, fees: 0, channel_id: "c" };
  const lines: PSaleLine[] = [{ order_id: "o1", sku: "HCJ86", name: "Hot Wheels Car Culture Deora", quantity: 3, total: 30 }];
  const stats = poolStats(pools, buys, "2026-12-31");
  const mk = (skuCosts: { sku: string; unit_cost: number | null; pool_id: string | null }[]) =>
    costResolver({ pools, stats, receiptBasis: costBasis(buys, "2026-12-31"), skuCosts, storeProducts: [{ sku: "HCJ86", name: "Car Culture Deora", cost: null }] });

  const pooled = buildPnl({ from: "2026-01-01", to: "2026-12-31", orders: [order], saleLines: lines, inventoryBuys: buys, periodBuys: [], trips: [], costOf: mk([]) });
  assertEquals([pooled.cogs, pooled.products[0].costSource, pooled.products[0].costLabel, pooled.unmatched.length], [21, "pool", "Car Culture", 0]);

  const swapped = buildPnl({ from: "2026-01-01", to: "2026-12-31", orders: [order], saleLines: lines, inventoryBuys: buys, periodBuys: [], trips: [], costOf: mk([{ sku: "HCJ86", unit_cost: 5, pool_id: null }]) });
  assertEquals([swapped.cogs, swapped.products[0].costSource], [15, "manual"]);

  const stock = onHand({
    asOf: "2026-12-31", inventoryBuys: buys, orders: [order], saleLines: lines, costOf: mk([]),
    pools: [...stats.values()].map((s) => ({ id: s.pool.id, name: s.pool.name, units: s.units, unit: s.unit })),
    storeStock: new Map([["MAN1", 4]]),
  });
  const cc = stock.rows.find((r) => r.key === "pool:cc")!;
  assertEquals([cc.bought, cc.sold, cc.onHand, cc.value], [10, 3, 7, 49]);
  assertEquals(stock.rows.find((r) => r.key === "HCJ85")?.basis, "receipts");

  const withManual = onHand({
    asOf: "2026-12-31", inventoryBuys: [], orders: [], saleLines: [], storeStock: new Map([["MAN1", 4]]),
    costOf: (sku) => (sku === "MAN1" ? { unit: 2.5, source: "manual", label: "Your cost" } : null),
  });
  assertEquals(withManual.rows.map((r) => [r.key, r.basis, r.onHand, r.value]), [["MAN1", "store", 4, 10]]);
});

Deno.test("suggested product lines appear in both receipts and the store, specific lines first", () => {
  const s = suggestPools(
    ["Hot Wheels Car Culture Master", "Hot Wheels Single Pack", "Matchbox Moving Parts Signature", "Matchbox Car Assortment", "Paper towels"],
    ["Hot Wheels 2022 Car Culture Jay Leno", "Hot Wheels 2026 Silver Series", "Matchbox Moving Parts 2023 Ford", "M2 Machines 1976 GMC"],
  );
  assertEquals(s.map((x) => [x.name, x.purchases, x.products]), [["Hot Wheels Car Culture", 1, 1], ["Matchbox Moving Parts", 1, 1], ["Hot Wheels mainline", 1, 1]]);
});

Deno.test("SKU cost files", () => {
  const r = parseSkuCosts('sku,cost\nhcj85,$6.50\n"GJP91",4\nbad,\n\nHCJ85,7\n');
  assertEquals(r.rows, [{ sku: "HCJ85", unit_cost: 7 }, { sku: "GJP91", unit_cost: 4 }]);
  assertEquals(r.skipped, 1);
});
