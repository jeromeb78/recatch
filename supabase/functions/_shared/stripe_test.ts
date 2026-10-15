import { assertEquals } from "jsr:@std/assert@1";
import { checkKey, localDate, mapCharge } from "./stripe.ts";

Deno.test("maps a WooCommerce Stripe charge without customer data", () => {
  const p = mapCharge({
    id: "ch_1", amount: 5405, amount_refunded: 1000, currency: "usd", created: 1785000000, status: "succeeded", captured: true,
    description: "JTC Collectibles - Order 812", payment_intent: "pi_1",
    metadata: { order_id: "812", site_url: "https://jtc.example", customer_email: "x@y.z", customer_name: "Pat" },
    balance_transaction: { fee: 187, net: 5218 },
  }, "UTC");
  assertEquals(p, {
    external_id: "ch_1", payment_intent: "pi_1", paid_at: "2026-07-25T17:20:00.000Z", payment_date: "2026-07-25", status: "succeeded",
    currency: "USD", amount: 54.05, refunded: 10, fee: 1.87, net: 52.18, disputed: false, description: "JTC Collectibles - Order 812",
    order_ref: "812", site_url: "https://jtc.example",
  });
  assertEquals(JSON.stringify(p).includes("Pat") || JSON.stringify(p).includes("x@y.z"), false);
});

Deno.test("statuses and currencies", () => {
  const base = { id: "ch", amount: 1000, created: 1785000000 };
  assertEquals(mapCharge({ ...base, status: "succeeded", captured: false }).status, "pending");
  assertEquals(mapCharge({ ...base, status: "failed" }).status, "failed");
  assertEquals(mapCharge({ ...base, status: "succeeded", currency: "jpy" }).amount, 1000);
  assertEquals(mapCharge({ ...base, status: "succeeded", payment_intent: { id: "pi_2" } }).payment_intent, "pi_2");
});

Deno.test("local business day", () => {
  // 02:30 UTC on Jan 2 is still Jan 1 in New York.
  assertEquals(localDate(Date.UTC(2026, 0, 2, 2, 30) / 1000, "America/New_York"), "2026-01-01");
  assertEquals(localDate(Date.UTC(2026, 0, 2, 2, 30) / 1000, "Not/AZone"), "2026-01-02");
});

Deno.test("only restricted keys", () => {
  assertEquals(checkKey("rk_live_51AbCdEfGhIjKlMn"), { ok: true, live: true });
  assertEquals(checkKey("rk_test_51AbCdEfGhIjKlMn"), { ok: true, live: false });
  assertEquals(checkKey("sk_live_51AbCdEfGhIjKlMn").ok, false);
  assertEquals(checkKey("pk_live_x").ok, false);
  assertEquals(checkKey("").ok, false);
});
