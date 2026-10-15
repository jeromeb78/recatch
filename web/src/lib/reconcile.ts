// Stripe as the source of truth for money. Each Stripe charge is matched to its store order — by the transaction id
// WooCommerce saved on the order (ch_… or pi_…), else by the order number Stripe keeps in the charge's metadata — and the
// order takes Stripe's amount, refunds, fee and outcome. The order keeps its items (for cost of goods) and its sales tax.
// Charges with no store order count as sales of their own; store orders paid by Stripe with no charge are flagged.
// Pure, for tests.

import type { POrder } from "./pnl";

export interface ROrder extends POrder {
  external_id: string;
  order_number: string | null;
  business_id: string | null;
  payment_method: string | null;
  payment_ref: string | null;
}

export interface RPayment {
  id: string;
  account_id: string;
  external_id: string;
  payment_intent: string | null;
  payment_date: string;
  status: "succeeded" | "pending" | "failed";
  amount: number | string;
  refunded: number | string;
  fee: number | string;
  disputed: boolean;
  description: string | null;
  order_ref: string | null;
  site_url: string | null;
}

export interface RChannel { id: string; kind: string; store_url: string | null }
export interface RAccount { id: string; business_id: string | null }

interface Entry { date: string; business_id: string | null }
export interface Difference extends Entry { orderId: string; number: string; store: number; stripe: number }

export interface Reconciliation {
  /** Orders with Stripe's numbers applied, plus one per charge that has no store order. */
  orders: ROrder[];
  matched: Entry[];
  /** Charges with no store order (counted as sales). */
  stripeOnly: (Entry & { id: string; amount: number; description: string | null })[];
  /** Store orders paid by Stripe that Stripe has no successful charge for (store numbers kept). */
  missingInStripe: (Entry & { orderId: string; number: string; total: number })[];
  /** Store total (items + shipping + tax) differs from what Stripe charged. */
  amountDiffs: Difference[];
  /** Store says paid but Stripe refunded it, or store says cancelled but Stripe kept the money. */
  statusDiffs: (Entry & { orderId: string; number: string; store: string; stripe: string })[];
  disputed: number;
  feesFromStripe: number;
}

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const host = (u: string | null | undefined) => {
  try { return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : null; } catch { return null; }
};
const STRIPE_METHOD = /stripe|wcpay|woocommerce_payments/i;

export function reconcile(args: { orders: ROrder[]; payments: RPayment[]; channels: RChannel[]; accounts: RAccount[] }): Reconciliation {
  const woo = new Map(args.channels.filter((c) => c.kind === "woocommerce").map((c) => [c.id, host(c.store_url)]));
  const byRef = new Map<string, ROrder>();
  const byNumber = new Map<string, ROrder[]>();
  for (const o of args.orders) {
    if (o.payment_ref) byRef.set(o.payment_ref.toLowerCase(), o);
    if (woo.has(o.channel_id)) byNumber.set(o.external_id, [...(byNumber.get(o.external_id) ?? []), o]);
  }
  const orderFor = (p: RPayment): ROrder | null => {
    const direct = byRef.get(p.external_id.toLowerCase()) ?? (p.payment_intent ? byRef.get(p.payment_intent.toLowerCase()) : undefined);
    if (direct) return direct;
    if (!p.order_ref) return null;
    const site = host(p.site_url);
    const candidates = (byNumber.get(p.order_ref) ?? []).filter((o) => !site || !woo.get(o.channel_id) || woo.get(o.channel_id) === site);
    return candidates.length === 1 ? candidates[0] : null;
  };

  const bizOf = new Map(args.accounts.map((a) => [a.id, a.business_id]));
  const perOrder = new Map<string, RPayment[]>();
  const stripeOnly: Reconciliation["stripeOnly"] = [];
  const extra: ROrder[] = [];
  let disputed = 0, feesFromStripe = 0;
  for (const p of args.payments) {
    if (p.disputed) disputed++;
    const o = orderFor(p);
    if (o) { perOrder.set(o.id, [...(perOrder.get(o.id) ?? []), p]); continue; }
    if (p.status !== "succeeded") continue;
    stripeOnly.push({ id: p.external_id, date: p.payment_date, business_id: bizOf.get(p.account_id) ?? null, amount: n(p.amount), description: p.description });
    feesFromStripe += n(p.fee);
    extra.push({
      id: `stripe:${p.id}`, order_date: p.payment_date, status: n(p.refunded) >= n(p.amount) && n(p.amount) > 0 ? "refunded" : "paid",
      items_total: n(p.amount), shipping_charged: 0, tax_collected: 0, refunded: n(p.refunded), fees: n(p.fee),
      channel_id: `stripe:${p.account_id}`, external_id: p.external_id, order_number: null, business_id: bizOf.get(p.account_id) ?? null,
      payment_method: "stripe", payment_ref: p.external_id,
    });
  }

  const amountDiffs: Difference[] = [];
  const statusDiffs: Reconciliation["statusDiffs"] = [];
  const missingInStripe: Reconciliation["missingInStripe"] = [];
  const firstPayment = args.payments.reduce<string | null>((a, p) => (!a || p.payment_date < a ? p.payment_date : a), null);
  const matched: Entry[] = [];
  const orders = args.orders.map((o): ROrder => {
    const ps = (perOrder.get(o.id) ?? []).filter((p) => p.status === "succeeded");
    const label = o.order_number ?? o.external_id;
    const storeTotal = r2(n(o.items_total) + n(o.shipping_charged) + n(o.tax_collected));
    if (!ps.length) {
      if (o.status === "paid" && o.payment_method && STRIPE_METHOD.test(o.payment_method) && firstPayment && o.order_date >= firstPayment) {
        missingInStripe.push({ orderId: o.id, number: label, date: o.order_date, business_id: o.business_id, total: storeTotal });
      }
      return o;
    }
    matched.push({ date: o.order_date, business_id: o.business_id });
    const amount = r2(ps.reduce((a, p) => a + n(p.amount), 0));
    const refunded = r2(ps.reduce((a, p) => a + n(p.refunded), 0));
    const fees = r2(ps.reduce((a, p) => a + n(p.fee), 0));
    feesFromStripe += fees;
    if (Math.abs(storeTotal - amount) > 0.01) amountDiffs.push({ orderId: o.id, number: label, date: o.order_date, business_id: o.business_id, store: storeTotal, stripe: amount });
    const status: POrder["status"] = refunded >= amount ? "refunded" : "paid";
    if (o.status !== status) statusDiffs.push({ orderId: o.id, number: label, date: o.order_date, business_id: o.business_id, store: o.status, stripe: status });
    // Stripe's charge includes shipping and sales tax; what's left is the items.
    const items = r2(Math.max(0, amount - n(o.tax_collected) - n(o.shipping_charged)));
    return { ...o, status, items_total: items, refunded, fees };
  });

  return {
    orders: [...orders, ...extra], matched, stripeOnly, missingInStripe, amountDiffs, statusDiffs, disputed, feesFromStripe: r2(feesFromStripe),
  };
}

/** Orders for one business ("all", "none" = unassigned, or an id). */
export function inScope<T extends { business_id: string | null }>(rows: T[], biz: string): T[] {
  return biz === "all" ? rows : rows.filter((r) => (biz === "none" ? r.business_id === null : r.business_id === biz));
}
