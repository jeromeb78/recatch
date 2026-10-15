import { assertEquals } from "jsr:@std/assert@1";
import { isPublicHost, mapOrder, orderFees, productCost, storeBase, validKeys } from "./woo.ts";

Deno.test("maps a paid order with refunds, fees and no customer data", () => {
  const m = mapOrder({
    id: 812, number: "812", status: "completed", currency: "usd",
    date_created: "2026-08-01T21:05:00", date_paid: "2026-08-02T09:00:00", date_modified_gmt: "2026-08-03T10:00:00",
    discount_total: "5.00", shipping_total: "6.95", total_tax: "2.10", total: "54.05",
    line_items: [{ name: "Hot Wheels '67 Camaro", sku: " HW-67 ", quantity: 2, total: "30.00" }, { name: "Mystery box", sku: "", quantity: 1, total: "15.00" }],
    refunds: [{ total: "-10.00" }],
    meta_data: [{ key: "_stripe_fee", value: "1.87" }, { key: "_billing_email", value: "x@y.z" }],
    // deno-lint-ignore no-explicit-any
    billing: { first_name: "Pat" } as any,
  } as Parameters<typeof mapOrder>[0]);
  assertEquals(m?.order, {
    external_id: "812", order_number: "812", order_date: "2026-08-02", status: "paid", currency: "USD",
    items_total: 45, discount: 5, shipping_charged: 6.95, tax_collected: 2.1, refunded: 10, fees: 1.87, total: 54.05,
    payment_method: null, payment_ref: null,
  });
  assertEquals(m?.lines, [{ sku: "HW-67", name: "Hot Wheels '67 Camaro", quantity: 2, total: 30 }, { sku: null, name: "Mystery box", quantity: 1, total: 15 }]);
  assertEquals(JSON.stringify(m).includes("Pat") || JSON.stringify(m).includes("x@y.z"), false);
});

Deno.test("statuses", () => {
  const s = (status: string) => mapOrder({ id: 1, status, date_created: "2026-01-02T00:00:00" })?.order.status ?? null;
  assertEquals([s("processing"), s("on-hold"), s("refunded"), s("failed"), s("pending"), s("weird")], ["paid", "paid", "refunded", "cancelled", "pending", null]);
  assertEquals(mapOrder({ id: 1, status: "completed" }), null); // no date
});

Deno.test("fees from WooPayments and PayPal", () => {
  assertEquals(orderFees([{ key: "_wcpay_transaction_fee", value: 0.89 }, { key: "PayPal Transaction Fee", value: "$0.62" }, { key: "_other", value: 9 }]), 1.51);
});

Deno.test("store address", () => {
  assertEquals(storeBase("shop.example.com"), "https://shop.example.com");
  assertEquals(storeBase("https://example.com/store/wp-admin/admin.php?page=wc"), "https://example.com/store");
  assertEquals(storeBase("https://example.com/"), "https://example.com");
  assertEquals(typeof storeBase("http://example.com"), "object");
  assertEquals(typeof storeBase("https://localhost"), "object");
  assertEquals(typeof storeBase("https://10.0.0.5"), "object");
  assertEquals(typeof storeBase("https://[::1]"), "object");
  assertEquals(isPublicHost("db.internal"), false);
  assertEquals(isPublicHost("abc.supabase.co"), false);
  assertEquals(isPublicHost("www.mystore.com"), true);
});

Deno.test("keys", () => {
  assertEquals(validKeys("ck_" + "a".repeat(40), "cs_" + "b".repeat(40)), true);
  assertEquals(validKeys("cs_" + "a".repeat(40), "ck_" + "b".repeat(40)), false);
  assertEquals(validKeys("ck_short", "cs_short"), false);
});

Deno.test("payment reference for matching to Stripe", () => {
  const base = { id: 9, status: "completed", date_created: "2026-01-02T00:00:00", payment_method: "stripe" };
  assertEquals(mapOrder({ ...base, transaction_id: "ch_123" })?.order.payment_ref, "ch_123");
  assertEquals(mapOrder({ ...base, transaction_id: "", meta_data: [{ key: "_stripe_intent_id", value: "pi_9" }] })?.order.payment_ref, "pi_9");
  assertEquals(mapOrder({ ...base })?.order.payment_method, "stripe");
});

Deno.test("product cost from WooCommerce or a cost plugin", () => {
  assertEquals(productCost({ cost_of_goods_sold: { total_value: 4.5 } }), 4.5);
  assertEquals(productCost({ cost_of_goods_sold: { total_value: 0 }, meta_data: [{ key: "_wc_cog_cost", value: "3.25" }] }), 3.25);
  assertEquals(productCost({ meta_data: [{ key: "_alg_wc_cog_cost", value: "2" }] }), 2);
  assertEquals(productCost({ meta_data: [{ key: "_other", value: "9" }] }), null);
  assertEquals(productCost({}), null);
});
