import { assertEquals } from "jsr:@std/assert@1";
import { checkToken, mapShipment, orderRef } from "./easyship.ts";

const base = {
  easyship_shipment_id: "ESUS100", created_at: "2026-08-01T14:00:00Z", label_paid_at: "2026-08-02T03:30:00Z",
  shipment_state: "created", label_state: "generated", courier_service: { id: "c2", name: "Ground Advantage", umbrella_name: "USPS" },
  destination_address: { country_alpha2: "US", contact_name: "Pat Doe", line_1: "1 Main St", contact_email: "x@y.z" },
  order_data: { platform_order_number: "#5012", platform_name: "WooCommerce" },
  rates: [{ courier_service: { id: "c1" }, currency: "USD", total_charge: 12.5 }, { courier_service: { id: "c2" }, currency: "usd", total_charge: 6.42 }],
  trackings: [{ tracking_number: null }, { tracking_number: "9400111" }],
};

Deno.test("maps a bought label without personal data", () => {
  const r = mapShipment(base, "America/New_York");
  assertEquals(r, {
    external_id: "ESUS100", order_ref: "5012", platform_name: "WooCommerce", ship_date: "2026-08-01", state: "active",
    label_state: "generated", courier: "USPS · Ground Advantage", tracking: "9400111", destination_country: "US", currency: "USD", label_cost: 6.42,
  });
  const text = JSON.stringify(r);
  assertEquals(text.includes("Pat") || text.includes("Main") || text.includes("@"), false);
});

Deno.test("quotes, voided and cancelled labels cost nothing", () => {
  assertEquals(mapShipment({ ...base, label_paid_at: null, label_state: "not_created" }).label_cost, 0);
  const voided = mapShipment({ ...base, label_state: "voided" });
  assertEquals([voided.state, voided.label_cost], ["cancelled", 0]);
  assertEquals(mapShipment({ ...base, shipment_state: "cancelled" }).state, "cancelled");
  assertEquals(mapShipment({ ...base, courier_service: { id: "zz" } }).label_cost, 12.5); // falls back to the first rate
});

Deno.test("order numbers and tokens", () => {
  assertEquals([orderRef(" #5012 "), orderRef(""), orderRef(null)], ["5012", null, null]);
  assertEquals(checkToken("prod_" + "a".repeat(40)), { ok: true, sandbox: false });
  assertEquals(checkToken("sand_" + "a".repeat(40)), { ok: true, sandbox: true });
  assertEquals(checkToken("short").ok, false);
});
