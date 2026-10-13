// deno test --sloppy-imports web/tests
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { findOpportunities, homeOfficeAmounts, itemDeduction, runScenario, suggestTrips, tripValue, type WLine, type WReceipt } from "../src/lib/writeoffs.ts";
import { mileageRate, rulesFor } from "../src/lib/taxrules.ts";

const base: WLine = {
  id: "1", receipt_id: "r1", description: "Item", tax_line: "c22", use_type: "business", tax_confidence: 0.9,
  business_pct: null, landed_total: 100, unit_price: 100, quantity: 1, woo_sku: null, is_business: true,
  purchase_date: "2026-08-01", merchant: "Walmart",
};
const r26 = rulesFor(2026);

Deno.test("mileage rate changes mid-2026 and per year", () => {
  assertEquals(mileageRate("2026-06-30"), 0.725);
  assertEquals(mileageRate("2026-07-01"), 0.76);
  assertEquals(mileageRate("2025-03-01"), 0.7);
  assertEquals(tripValue({ trip_date: "2026-07-15", miles: 10 }), 7.6);
  assert(rulesFor(2030).isEstimate);
});

Deno.test("item rules: personal, meals, mixed, low confidence, equipment", () => {
  assertEquals(itemDeduction({ ...base, use_type: "personal" }, "maximum", r26), null);
  assertEquals(itemDeduction({ ...base, tax_line: "c24b" }, "balanced", r26)?.amount, 50);
  assertEquals(itemDeduction({ ...base, use_type: "mixed" }, "conservative", r26), null);
  assertEquals(itemDeduction({ ...base, use_type: "mixed" }, "balanced", r26)?.amount, 50);
  assertEquals(itemDeduction({ ...base, use_type: "mixed", business_pct: 70 }, "conservative", r26)?.amount, 70);
  assertEquals(itemDeduction({ ...base, tax_confidence: 0.4 }, "conservative", r26), null);
  assertEquals(itemDeduction({ ...base, tax_confidence: 0.4 }, "balanced", r26)?.amount, 100);
  // Equipment: ≤ $2,500 always in full; above that depreciated 20% only in the conservative scenario.
  assertEquals(itemDeduction({ ...base, tax_line: "c13", landed_total: 2000, unit_price: 2000 }, "conservative", r26)?.amount, 2000);
  assertEquals(itemDeduction({ ...base, tax_line: "c13", landed_total: 4000, unit_price: 4000 }, "conservative", r26)?.amount, 800);
  assertEquals(itemDeduction({ ...base, tax_line: "c13", landed_total: 4000, unit_price: 4000 }, "balanced", r26)?.amount, 4000);
  assertEquals(itemDeduction({ ...base, tax_line: null }, "maximum", r26)?.line, "uncat");
  assertEquals(itemDeduction({ ...base, tax_line: null }, "balanced", r26), null);
});

Deno.test("home office: simplified capped at 300 sq ft; regular by share of home", () => {
  const h = homeOfficeAmounts({ sqft: 400, homeSqft: 2000, rent: 24000, utilities: 3000 }, r26);
  assertEquals(h.simplified, 1500);
  assertEquals(h.regular, 5400);
});

const receipts: WReceipt[] = [
  { id: "a", purchase_date: "2026-08-01", merchant: "Walmart", total: 20, shipping: 0, document_type: "receipt" },
  { id: "b", purchase_date: "2026-08-01", merchant: "Walmart", total: 5, shipping: null, document_type: "receipt" },
  { id: "c", purchase_date: "2026-08-02", merchant: "Walmart", total: 30, shipping: 5.99, document_type: "order_confirmation" },
  { id: "d", purchase_date: "2026-08-03", merchant: "Target", total: 12, shipping: 0, document_type: "receipt" },
];

Deno.test("suggested trips: one per store per day, skip logged, flag delivered orders", () => {
  const s = suggestTrips(receipts, [{ trip_date: "2026-08-03", destination: "Target", purpose: "x", miles: 8, merchant_key: "target", receipt_ids: [] }], { walmart: 12 });
  assertEquals(s.length, 2);
  assertEquals(s[0].receipts, 2);
  assertEquals(s[0].miles, 12);
  assert(s[0].likelyInStore);
  assert(!s[1].likelyInStore);
});

Deno.test("scenarios rank conservative ≤ balanced ≤ maximum and COGS uses inventory counts", () => {
  const lines: WLine[] = [
    { ...base, id: "inv", tax_line: "cogs", landed_total: 1000 },
    { ...base, id: "mix", use_type: "mixed", landed_total: 200 },
    { ...base, id: "low", tax_confidence: 0.3, landed_total: 60 },
    { ...base, id: "eq", tax_line: "c13", landed_total: 3000, unit_price: 3000 },
  ];
  const suggested = suggestTrips(receipts, [], { walmart: 10, target: 20 });
  const inputs = { inventory: { begin: 100, end: 300 }, homeOffice: { sqft: 100 }, phone: { monthly: 100, pct: 50 } };
  const [c, b, m] = (["conservative", "balanced", "maximum"] as const).map((scenario) =>
    runScenario({ year: 2026, scenario, lines, trips: [], suggested, inputs })
  );
  assertEquals(c.lines.cogs, 800); // 100 + 1000 − 300
  assertEquals(c.lines.c30, 500);
  assertEquals(c.lines.c25, 600);
  assertEquals(c.lines.c13, 600);
  assertEquals(b.lines.c13, 3000);
  assertEquals(c.lines.c9, undefined); // no saved log yet
  assertAlmostEquals(b.lines.c9, 7.6 + 15.2, 0.01); // in-store days: Walmart 10 mi + Target 20 mi at 76¢
  assertAlmostEquals(m.lines.c9, 7.6 + 15.2 + 7.6, 0.01); // + the delivered Walmart order
  assert(c.total <= b.total && b.total <= m.total);
  assert(b.assumptions.some((a) => a.includes("50%")));
});

Deno.test("opportunities flag missed write-offs", () => {
  const lines: WLine[] = [
    { ...base, id: "p", tax_line: "personal", use_type: "personal", description: "Scotch shipping tape 3pk" },
    { ...base, id: "u", tax_line: null },
    { ...base, id: "s", woo_sku: "HW-1", tax_line: "c22" },
    { ...base, id: "i", tax_line: "cogs" },
  ];
  const ops = findOpportunities({ year: 2026, lines, trips: [], suggested: suggestTrips(receipts, [], {}), inputs: {}, storeMiles: {} });
  const ids = ops.map((o) => o.id);
  for (const id of ["uncategorized", "sku-not-cogs", "personal-businessy", "mileage", "home-office", "fees", "ending-inventory", "qbi"]) {
    assert(ids.includes(id), `missing ${id}`);
  }
  assert(ops.find((o) => o.id === "1099")!.title.includes("2,000"));
});

Deno.test("inventory lookalikes: die-cast marked personal is flagged, groceries are not", async () => {
  const { inventoryLookalikes } = await import("../src/lib/writeoffs.ts");
  const inv = (d: string): WLine => ({ ...base, id: d, description: d, tax_line: "cogs" });
  const per = (d: string): WLine => ({ ...base, id: d, description: d, tax_line: "personal", use_type: "personal" });
  const lines = [
    inv("Hot Wheels 1:64 Scale Die-Cast Car"), inv("Hot Wheels Premium 1:64 Diecast"), inv("Matchbox 1:64 Scale Die-Cast Truck"),
    per("Monster Jam 1:64 Scale Die-Cast Monster Truck"), per("Hot Wheels Car Culture Single"),
    per("Swiss Miss Hot Cocoa Mix"), per("Great Value Shrimp 2 lb Bag"), per("Charmin Toilet Paper"),
  ];
  assertEquals(inventoryLookalikes(lines).map((l) => l.id), ["Monster Jam 1:64 Scale Die-Cast Monster Truck", "Hot Wheels Car Culture Single"]);
  const ops = findOpportunities({ year: 2026, lines, trips: [], suggested: [], inputs: {}, storeMiles: {}, hasBusinessDescription: false });
  assertEquals(ops[0].id, "describe");
  assert(!ops.some((o) => o.id === "personal-businessy"), "groceries must not be flagged as supplies");
});
