import { assertEquals } from "jsr:@std/assert@1";
import { inScope, reconcile, type RChannel, type ROrder, type RPayment } from "../src/lib/reconcile.ts";

const ch: RChannel[] = [{ id: "woo", kind: "woocommerce", store_url: "https://www.jtc.example" }, { id: "ebay", kind: "csv", store_url: null }];
const order = (o: Partial<ROrder>): ROrder => ({
  id: crypto.randomUUID(), order_date: "2026-05-01", status: "paid", items_total: 40, shipping_charged: 5, tax_collected: 3,
  refunded: 0, fees: 0.5, channel_id: "woo", external_id: "1", business_id: "b1", payment_method: "stripe", payment_ref: null, ...o,
  order_number: o.order_number ?? o.external_id ?? "1",
});
const pay = (p: Partial<RPayment>): RPayment => ({
  id: crypto.randomUUID(), account_id: "acct", external_id: "ch_x", payment_intent: null, payment_date: "2026-05-01", status: "succeeded",
  amount: 48, refunded: 0, fee: 1.69, disputed: false, description: null, order_ref: null, site_url: null, ...p,
});

Deno.test("Stripe's amounts, refunds and fees win for matched orders", () => {
  const byRef = order({ external_id: "100", payment_ref: "ch_100" });
  const byIntent = order({ external_id: "101", payment_ref: "pi_101" });
  const byMeta = order({ external_id: "102" });
  const ebaySame = order({ external_id: "103", channel_id: "ebay", payment_method: null }); // eBay order numbers never match Stripe metadata
  const r = reconcile({
    orders: [byRef, byIntent, byMeta, ebaySame],
    payments: [
      pay({ external_id: "ch_100", amount: 48, fee: 1.69 }),
      pay({ external_id: "ch_101", payment_intent: "pi_101", amount: 50, refunded: 50, fee: 1.75 }),
      pay({ external_id: "ch_102", order_ref: "102", site_url: "https://jtc.example", amount: 48, refunded: 10, fee: 1.69 }),
      pay({ external_id: "ch_103", order_ref: "103", amount: 20, fee: 0.88, description: "Payment link" }),
      pay({ external_id: "ch_fail", order_ref: "100", status: "failed", amount: 48 }),
    ],
    channels: ch, accounts: [{ id: "acct", business_id: "b1" }],
  });
  assertEquals(r.matched.length, 3);
  const get = (id: string) => r.orders.find((o) => o.id === id)!;
  assertEquals([get(byRef.id).items_total, get(byRef.id).fees, get(byRef.id).status], [40, 1.69, "paid"]);
  assertEquals([get(byIntent.id).status, get(byIntent.id).refunded], ["refunded", 50]);
  assertEquals([get(byMeta.id).refunded, get(byMeta.id).fees], [10, 1.69]);
  assertEquals(r.amountDiffs.map((d) => [d.number, d.store, d.stripe]), [["101", 48, 50]]);
  assertEquals(r.statusDiffs, [{ orderId: byIntent.id, number: "101", date: "2026-05-01", business_id: "b1", store: "paid", stripe: "refunded" }]);
  assertEquals(r.stripeOnly.map((s) => [s.id, s.amount]), [["ch_103", 20]]);
  const extra = r.orders.find((o) => o.id.startsWith("stripe:"))!;
  assertEquals([extra.items_total, extra.fees, extra.business_id, extra.status], [20, 0.88, "b1", "paid"]);
  assertEquals(r.feesFromStripe, 1.69 + 1.75 + 1.69 + 0.88);
  assertEquals(get(ebaySame.id).fees, 0.5); // untouched
});

Deno.test("store orders paid by Stripe with no charge are flagged, from when Stripe data starts", () => {
  const before = order({ external_id: "1", order_date: "2026-01-01" });
  const after = order({ external_id: "2", order_date: "2026-06-01" });
  const paypal = order({ external_id: "3", order_date: "2026-06-01", payment_method: "ppcp-gateway" });
  const r = reconcile({ orders: [before, after, paypal], payments: [pay({ payment_date: "2026-03-01", external_id: "ch_other" })], channels: ch, accounts: [] });
  assertEquals(r.missingInStripe.map((m) => m.number), ["2"]);
});

Deno.test("a charge from another store with the same order number isn't matched", () => {
  const o = order({ external_id: "55" });
  const r = reconcile({ orders: [o], payments: [pay({ order_ref: "55", site_url: "https://other.example" })], channels: ch, accounts: [] });
  assertEquals([r.matched.length, r.stripeOnly.length], [0, 1]);
});

Deno.test("scope", () => {
  const rows = [{ business_id: "a" }, { business_id: null }, { business_id: "b" }];
  assertEquals([inScope(rows, "all").length, inScope(rows, "none").length, inScope(rows, "a").length], [3, 1, 1]);
});
