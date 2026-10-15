// Easyship shipments → shipments rows. Pure; network code lives in shipping-sync.
// Keeps the label cost, dates, courier, tracking number and destination country — never names, addresses or contact details.
import { localDate } from "./stripe.ts";

export interface EasyshipRate {
  courier_service?: { id?: string } | null;
  currency?: string;
  total_charge?: number | null;
}

export interface EasyshipShipment {
  easyship_shipment_id: string;
  created_at?: string | null;
  label_paid_at?: string | null;
  label_generated_at?: string | null;
  shipment_state?: string | null;
  label_state?: string | null;
  currency?: string | null;
  courier_service?: { id?: string; name?: string; umbrella_name?: string } | null;
  destination_address?: { country_alpha2?: string } | null;
  order_data?: { platform_order_number?: string | null; platform_name?: string | null } | null;
  rates?: EasyshipRate[] | null;
  trackings?: { tracking_number?: string | null }[] | null;
}

export interface ShipmentRow {
  external_id: string;
  order_ref: string | null;
  platform_name: string | null;
  ship_date: string;
  state: "active" | "cancelled";
  label_state: string | null;
  courier: string | null;
  tracking: string | null;
  destination_country: string | null;
  currency: string;
  label_cost: number;
}

const PURCHASED = new Set(["generated", "printed"]);
const VOIDED = new Set(["voided", "voiding", "cancelled", "refunded"]);

/** "#5012" / " 5012 " → "5012", so it lines up with the store's order number. */
export function orderRef(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/^#/, "").trim();
  return s || null;
}

export function mapShipment(s: EasyshipShipment, timeZone?: string): ShipmentRow {
  const rates = s.rates ?? [];
  const rate = rates.find((r) => r.courier_service?.id && r.courier_service.id === s.courier_service?.id) ?? rates[0];
  const cancelled = s.shipment_state === "cancelled" || VOIDED.has(s.label_state ?? "");
  // Only a bought label costs money; a shipment that only has quotes doesn't.
  const bought = !cancelled && (!!s.label_paid_at || PURCHASED.has(s.label_state ?? ""));
  const when = s.label_paid_at ?? s.label_generated_at ?? s.created_at ?? new Date().toISOString();
  const courier = [s.courier_service?.umbrella_name, s.courier_service?.name].filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i).join(" · ");
  return {
    external_id: s.easyship_shipment_id,
    order_ref: orderRef(s.order_data?.platform_order_number),
    platform_name: s.order_data?.platform_name ?? null,
    ship_date: localDate(Math.floor(new Date(when).getTime() / 1000), timeZone),
    state: cancelled ? "cancelled" : "active",
    label_state: s.label_state ?? null,
    courier: courier || null,
    tracking: s.trackings?.find((t) => t.tracking_number)?.tracking_number ?? null,
    destination_country: s.destination_address?.country_alpha2 ?? null,
    currency: (rate?.currency ?? s.currency ?? "USD").toUpperCase(),
    label_cost: bought ? Math.round((Number(rate?.total_charge) || 0) * 100) / 100 : 0,
  };
}

export function checkToken(t: unknown): { ok: true; sandbox: boolean } | { ok: false; error: string } {
  const v = typeof t === "string" ? t.trim() : "";
  if (!/^[A-Za-z0-9_+/=.-]{20,400}$/.test(v)) return { ok: false, error: "Paste the API access token from Easyship (Connect → API Integration)." };
  return { ok: true, sandbox: v.startsWith("sand_") };
}
