import { assertEquals } from "jsr:@std/assert@1";
import { reconcileShipping, type RShipment } from "../src/lib/shipping.ts";
import { buildPnl } from "../src/lib/pnl.ts";
import type { ROrder } from "../src/lib/reconcile.ts";

const order = (o: Partial<ROrder>): ROrder => ({
  id: crypto.randomUUID(), order_date: "2026-05-01", status: "paid", items_total: 40, shipping_charged: 5.95, tax_collected: 3,
  refunded: 0, fees: 1.5, channel_id: "woo", external_id: "1", business_id: "b1", payment_method: "stripe", payment_ref: null, ...o,
  order_number: o.order_number ?? o.external_id ?? "1",
});
const label = (s: Partial<RShipment>): RShipment => ({
  id: crypto.randomUUID(), account_id: "ez", external_id: "ES" + Math.random(), order_ref: null, ship_date: "2026-05-02", state: "active",
  label_cost: 6.42, courier: "USPS", tracking: null, ...s,
});

Deno.test("labels against what customers paid for shipping", () => {
  const a = order({ external_id: "5012" });
  const b = order({ external_id: "5013", status: "refunded" });
  const c = order({ external_id: "5014", order_date: "2026-05-03" }); // paid, never shipped
  const recent = order({ external_id: "5015", order_date: "2026-05-09" }); // too new to flag
  const ebay = order({ external_id: "5012", channel_id: "ebay" }); // same number on eBay: the store order wins
  const stripeOnly = order({ id: "stripe:x", external_id: "ch_1" });
  const ebayUnshipped = order({ external_id: "7001", channel_id: "ebay", order_date: "2026-05-03" }); // eBay ships with its own labels
  const r = reconcileShipping({
    orders: [a, b, c, recent, ebay, stripeOnly, ebayUnshipped],
    shipments: [
      label({ order_ref: "#5012", label_cost: 4.1 }), label({ order_ref: "5012", label_cost: 4.1, ship_date: "2026-05-06" }), // reship
      label({ order_ref: "5013", label_cost: 7 }),
      label({ order_ref: "9999", label_cost: 3 }),
      label({ order_ref: "5014", state: "cancelled", label_cost: 5 }),
      label({ order_ref: "5014", label_cost: 0 }),
    ],
    wooChannels: new Set(["woo"]), accounts: [{ id: "ez", business_id: "b2" }], today: "2026-05-10",
  });
  assertEquals(r.orders.map((o) => [o.number, o.charged, o.cost, o.labels, o.refunded]), [["5012", 5.95, 8.2, 2, false], ["5013", 5.95, 7, 1, true]]);
  assertEquals(r.unmatched.map((u) => [u.orderRef, u.cost, u.business_id]), [["9999", 3, "b2"]]);
  assertEquals(r.unshipped.map((u) => u.number), ["5014"]);
  assertEquals(r.expenses.reduce((s, e) => s + e.amount, 0), 4.1 + 4.1 + 7 + 3);
  assertEquals(r.expenses.map((e) => e.business_id), ["b1", "b1", "b1", "b2"]);
});

Deno.test("label costs land in profit as their own expense line", () => {
  const p = buildPnl({
    from: "2026-01-01", to: "2026-12-31", orders: [order({})], saleLines: [], inventoryBuys: [], periodBuys: [], trips: [],
    otherExpenses: [{ key: "ship", label: "Shipping labels", date: "2026-05-02", amount: 6.42 }, { key: "ship", label: "Shipping labels", date: "2025-12-31", amount: 9 }],
  });
  assertEquals(p.expenses, [{ line: "ship", label: "Shipping labels", amount: 6.42 }]);
  assertEquals(p.profit, Math.round((40 + 5.95 - 1.5 - 6.42) * 100) / 100);
});
