// GENERATED from web/src/lib/shipping.ts by scripts/sync-profit-lib.mjs — edit the original, then re-run the script.
// Shipping reconciliation: label costs (Easyship) against what customers paid for shipping on Stripe-confirmed orders.
// Labels are matched to store orders by the order number they were bought for. Pure, for tests.

import type { ROrder } from "./reconcile.ts";

export interface RShipment {
  id: string;
  account_id: string;
  external_id: string;
  order_ref: string | null;
  ship_date: string;
  state: "active" | "cancelled";
  label_cost: number | string;
  courier: string | null;
  tracking: string | null;
}

interface Entry { date: string; business_id: string | null }

export interface ShippingCheck {
  /** Label costs as expenses (for profit), dated when bought, in the order's business (else the account's). */
  expenses: (Entry & { amount: number })[];
  /** One row per order with a label: what the customer paid for shipping vs what the labels cost. */
  orders: (Entry & { orderId: string; number: string; charged: number; cost: number; labels: number; refunded: boolean })[];
  /** Labels whose order number matches no store order. */
  unmatched: (Entry & { id: string; orderRef: string | null; cost: number; courier: string | null })[];
  /** Paid orders that charged shipping but have no label, in channels that ship with Easyship (from when its data starts). */
  unshipped: (Entry & { orderId: string; number: string; charged: number })[];
}

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/^#/, "").trim().toLowerCase();

export function reconcileShipping(args: {
  orders: ROrder[];
  shipments: RShipment[];
  wooChannels: Set<string>;
  accounts: { id: string; business_id: string | null }[];
  /** Orders newer than this (days ago) may simply not have shipped yet. */
  today: string;
  graceDays?: number;
}): ShippingCheck {
  // Order number → order. Store (WooCommerce) orders win; otherwise only an unambiguous match counts.
  const byNumber = new Map<string, ROrder[]>();
  for (const o of args.orders) {
    if (o.id.startsWith("stripe:")) continue;
    for (const k of new Set([norm(o.order_number), norm(o.external_id)])) {
      if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), o]);
    }
  }
  const find = (ref: string | null): ROrder | null => {
    const list = byNumber.get(norm(ref)) ?? [];
    const woo = list.filter((o) => args.wooChannels.has(o.channel_id));
    if (woo.length === 1) return woo[0];
    return list.length === 1 ? list[0] : null;
  };
  const bizOf = new Map(args.accounts.map((a) => [a.id, a.business_id]));

  const expenses: ShippingCheck["expenses"] = [];
  const perOrder = new Map<string, { o: ROrder; cost: number; labels: number; first: string }>();
  const unmatched: ShippingCheck["unmatched"] = [];
  let firstLabel: string | null = null;
  for (const s of args.shipments) {
    if (s.state !== "active" || n(s.label_cost) <= 0) continue;
    const o = find(s.order_ref);
    const cost = n(s.label_cost);
    expenses.push({ date: s.ship_date, business_id: o?.business_id ?? bizOf.get(s.account_id) ?? null, amount: cost });
    if (!firstLabel || s.ship_date < firstLabel) firstLabel = s.ship_date;
    if (!o) {
      unmatched.push({ id: s.external_id, date: s.ship_date, business_id: bizOf.get(s.account_id) ?? null, orderRef: s.order_ref, cost, courier: s.courier });
      continue;
    }
    const e = perOrder.get(o.id) ?? { o, cost: 0, labels: 0, first: s.ship_date };
    e.cost += cost;
    e.labels++;
    if (s.ship_date < e.first) e.first = s.ship_date;
    perOrder.set(o.id, e);
  }

  const orders: ShippingCheck["orders"] = [...perOrder.values()].map(({ o, cost, labels }) => ({
    orderId: o.id, number: o.order_number ?? o.external_id, date: o.order_date, business_id: o.business_id,
    charged: r2(n(o.shipping_charged)), cost: r2(cost), labels, refunded: o.status === "refunded",
  }));

  // Only channels that ship with Easyship can be missing a label (eBay orders often use eBay's own labels).
  const shipsWithEasyship = new Set([...perOrder.values()].map((e) => e.o.channel_id));
  const grace = new Date(new Date(args.today).getTime() - (args.graceDays ?? 3) * 86400_000).toISOString().slice(0, 10);
  const unshipped: ShippingCheck["unshipped"] = firstLabel ? args.orders
    .filter((o) => !o.id.startsWith("stripe:") && o.status === "paid" && n(o.shipping_charged) > 0 && !perOrder.has(o.id)
      && shipsWithEasyship.has(o.channel_id) && o.order_date >= firstLabel! && o.order_date <= grace)
    .map((o) => ({ orderId: o.id, number: o.order_number ?? o.external_id, date: o.order_date, business_id: o.business_id, charged: r2(n(o.shipping_charged)) }))
    : [];

  return { expenses, orders, unmatched, unshipped };
}
