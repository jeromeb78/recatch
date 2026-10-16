// Profit tools for Claude: sales (WooCommerce / imports) checked against Stripe, Easyship label costs, cost of goods
// (your SKU costs → store cost → tagged receipts → product lines) and inventory on hand. Uses the same calculations as
// the app's Profit tab (generated copies in ../_shared/profit). Every query is scoped to the authenticated user.
import { adminClient } from "../_shared/utils.ts";
import { buildPnl, costBasis, onHand, skuKey, type PBuyLine, type PSaleLine, type PTrip } from "../_shared/profit/pnl.ts";
import { costResolver, poolStats, type CostPool, type SkuCost } from "../_shared/profit/costs.ts";
import { inScope, reconcile, type RAccount, type RChannel, type ROrder, type RPayment } from "../_shared/profit/reconcile.ts";
import { reconcileShipping, type RShipment } from "../_shared/profit/shipping.ts";

export class ProfitError extends Error {}

const PAGE = 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const BUY = "id, description, woo_sku, units, quantity, landed_total, tax_line, use_type, business_pct, purchase_date, merchant";

type Q = { range(a: number, b: number): PromiseLike<{ data: unknown; error: { message: string } | null }> };
async function all<T>(q: () => Q): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += PAGE) {
    const { data, error } = await q().range(a, a + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (((data ?? []) as T[]).length < PAGE) return out;
  }
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Period from args: from/to (YYYY-MM-DD) or year; defaults to this year to date. */
export function period(a: Record<string, unknown>): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (a.year !== undefined) {
    const y = Math.floor(Number(a.year));
    if (!(y > 1990 && y < 2200)) throw new ProfitError("year must be like 2026.");
    return { from: `${y}-01-01`, to: `${y}-12-31` < today ? `${y}-12-31` : today };
  }
  const from = isDate(a.from) ? a.from : `${today.slice(0, 4)}-01-01`;
  const to = isDate(a.to) ? a.to : today;
  if (from > to) throw new ProfitError("from must be on or before to.");
  return { from, to };
}

/** "all" (default), "none" (not assigned), or a business id / name. */
async function businessScope(userId: string, v: unknown): Promise<{ biz: string; name: string | null }> {
  if (v === undefined || v === null || v === "" || v === "all") return { biz: "all", name: null };
  if (v === "none") return { biz: "none", name: "Not assigned" };
  const s = String(v).trim();
  const { data } = await adminClient().from("businesses").select("id, name").eq("user_id", userId);
  const b = (data ?? []).find((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase());
  if (!b) throw new ProfitError(`No business called "${s}". Businesses: ${(data ?? []).map((x) => x.name).join(", ") || "none set up"}.`);
  return { biz: b.id as string, name: b.name as string };
}

export interface ProfitData {
  from: string; to: string; biz: string; businessName: string | null;
  orders: ROrder[]; lines: PSaleLine[]; inventoryBuys: PBuyLine[]; periodBuys: PBuyLine[]; trips: PTrip[];
  stock: Map<string, number>; rec: ReturnType<typeof reconcile> | null; ship: ReturnType<typeof reconcileShipping> | null;
  costOf: ReturnType<typeof costResolver>; stats: ReturnType<typeof poolStats>;
  connected: { stores: number; stripe: number; easyship: number };
}

/** Everything the Profit tab loads, for one user, business and period. */
export async function loadProfit(userId: string, a: Record<string, unknown>): Promise<ProfitData> {
  const db = adminClient();
  const { from, to } = period(a);
  const { biz, name } = await businessScope(userId, a.business);
  const scoped = <T>(q: T, col = "business_id"): T => {
    const b = q as unknown as { eq(c: string, v: string): T; is(c: string, v: null): T };
    return biz === "all" ? q : biz === "none" ? b.is(col, null) : b.eq(col, biz);
  };
  const [channels, accounts, shippers] = await Promise.all([
    all<RChannel>(() => db.from("sales_channels").select("id, kind, store_url").eq("user_id", userId)),
    all<RAccount>(() => db.from("payment_accounts").select("id, business_id").eq("user_id", userId)),
    all<RAccount>(() => db.from("shipping_accounts").select("id, business_id").eq("user_id", userId)),
  ]);
  const [allOrders, payments, shipments, lines, inventoryBuys, untagged, periodBuys, trips, products, pools, skuCosts] = await Promise.all([
    all<ROrder>(() => db.from("sales_orders")
      .select("id, order_date, status, items_total, shipping_charged, tax_collected, refunded, fees, channel_id, external_id, order_number, business_id, payment_method, payment_ref")
      .eq("user_id", userId).lte("order_date", to).order("order_date")),
    accounts.length ? all<RPayment>(() => db.from("payments")
      .select("id, account_id, external_id, payment_intent, payment_date, status, amount, refunded, fee, disputed, description, order_ref, site_url")
      .eq("user_id", userId).lte("payment_date", to).order("payment_date")) : Promise.resolve([]),
    shippers.length ? all<RShipment>(() => db.from("shipments").select("id, account_id, external_id, order_ref, ship_date, state, label_cost, courier, tracking")
      .eq("user_id", userId).lte("ship_date", to).order("ship_date")) : Promise.resolve([]),
    all<PSaleLine>(() => scoped(db.from("sales_lines").select("order_id, sku, name, quantity, total, sales_orders!inner(business_id, order_date)")
      .eq("user_id", userId).lte("sales_orders.order_date", to), "sales_orders.business_id").order("id")),
    all<PBuyLine>(() => scoped(db.from("inventory_lines").select(BUY).eq("user_id", userId).not("woo_sku", "is", null).lte("purchase_date", to)).order("purchase_date")),
    all<PBuyLine>(() => scoped(db.from("inventory_lines").select(BUY).eq("user_id", userId).is("woo_sku", null).eq("tax_line", "cogs")).order("purchase_date")),
    all<PBuyLine & { merchant: string | null }>(() => scoped(db.from("inventory_lines").select(BUY).eq("user_id", userId).gte("purchase_date", from).lte("purchase_date", to)).order("purchase_date")),
    all<PTrip>(() => scoped(db.from("trips").select("trip_date, miles").eq("user_id", userId).gte("trip_date", from).lte("trip_date", to)).order("trip_date")),
    all<{ sku: string; name: string; stock: number | null; cost: number | null }>(() => db.from("sales_products").select("sku, name, stock, cost").eq("user_id", userId).order("sku")),
    all<CostPool & { business_id: string | null }>(() => {
      const q = db.from("cost_pools").select("id, name, purchase_words, product_words, unit_cost, position, business_id").eq("user_id", userId);
      return (biz === "all" ? q : biz === "none" ? q.is("business_id", null) : q.or(`business_id.eq.${biz},business_id.is.null`)).order("position");
    }),
    all<SkuCost>(() => db.from("sku_costs").select("sku, unit_cost, pool_id").eq("user_id", userId).order("sku")),
  ]);

  const rec = accounts.length ? reconcile({ orders: allOrders, payments, channels, accounts }) : null;
  const merged = rec ? rec.orders : allOrders;
  const ship = shippers.length ? reconcileShipping({
    orders: merged, shipments, accounts: shippers, today: to, wooChannels: new Set(channels.filter((c) => c.kind === "woocommerce").map((c) => c.id)),
  }) : null;
  const stats = poolStats(pools, untagged, to);
  const costOf = costResolver({ pools, stats, skuCosts, storeProducts: products, receiptBasis: costBasis(inventoryBuys, to) });
  const stock = new Map<string, number>();
  for (const p of products) if (p.stock != null) stock.set(skuKey(p.sku), (stock.get(skuKey(p.sku)) ?? 0) + Number(p.stock));
  return {
    from, to, biz, businessName: name, orders: inScope(merged, biz), lines, inventoryBuys,
    // Easyship label charges come from Easyship; a receipt for the same labels would count them twice.
    periodBuys: ship ? periodBuys.filter((l) => !/easyship/i.test(l.merchant ?? "")) : periodBuys,
    trips, stock, rec, ship, costOf, stats, connected: { stores: channels.length, stripe: accounts.length, easyship: shippers.length },
  };
}

export function pnlFor(d: ProfitData) {
  const labels = d.ship ? inScope(d.ship.expenses, d.biz).map((e) => ({ key: "ship", label: "Shipping labels (Easyship)", date: e.date, amount: e.amount })) : [];
  return buildPnl({ from: d.from, to: d.to, orders: d.orders, saleLines: d.lines, inventoryBuys: d.inventoryBuys, periodBuys: d.periodBuys, trips: d.trips, otherExpenses: labels, costOf: d.costOf });
}

const within = <T extends { date: string; business_id: string | null }>(d: ProfitData, xs: T[]) =>
  inScope(xs, d.biz).filter((x) => x.date >= d.from && x.date <= d.to);

const scopeNote = (d: ProfitData) => ({ from: d.from, to: d.to, business: d.businessName ?? "all businesses" });

/* ---------------- tool handlers ---------------- */

export async function profitSummary(userId: string, a: Record<string, unknown>) {
  const d = await loadProfit(userId, a);
  if (!d.connected.stores && !d.connected.stripe) {
    return { ...scopeNote(d), note: "No sales connected yet. Connect WooCommerce, Stripe or import sales in Receipt Catcher → Settings → Sales." };
  }
  const p = pnlFor(d);
  const sources: Record<string, number> = { your_cost: 0, store_cost: 0, tagged_receipts: 0, product_line: 0, no_cost: 0 };
  const key = { manual: "your_cost", store: "store_cost", receipts: "tagged_receipts", pool: "product_line" } as const;
  for (const x of p.products) sources[x.costSource ? key[x.costSource] : "no_cost"] += x.units;
  return {
    ...scopeNote(d),
    sources_connected: d.connected,
    orders: p.orders, units_sold: p.units,
    schedule_c: { line1_gross_sales: p.gross, line2_returns: p.returns, line4_cost_of_goods: p.cogs, line10_fees: p.fees },
    net_sales: p.netSales, cost_of_goods: p.cogs, gross_profit: p.grossProfit, fees: p.fees,
    expenses: p.expenses.map((e) => ({ line: e.label, amount: e.amount })), expense_total: p.expenseTotal, mileage: p.mileage,
    profit: p.profit, margin_pct: p.margin === null ? null : r2(p.margin * 100), sales_tax_collected: p.taxCollected,
    units_sold_by_cost_source: sources,
    products_without_cost: { count: p.unmatched.length, sales: p.unmatchedRevenue },
    by_month: p.months,
    notes: [
      d.connected.stripe ? "Sales, refunds and fees come from Stripe where a charge matches the store order." : "Stripe isn't connected; sales and fees come from the store.",
      "Cost of goods = units sold × unit cost (your SKU cost → store cost → tagged receipts → product-line average).",
      "Figures are management numbers to check with a tax preparer, not tax advice.",
    ],
  };
}

export async function productProfit(userId: string, a: Record<string, unknown>) {
  const d = await loadProfit(userId, a);
  const p = pnlFor(d);
  const term = typeof a.query === "string" ? a.query.trim().toLowerCase() : "";
  const sku = typeof a.sku === "string" ? a.sku.trim().toUpperCase() : "";
  const sort = ["revenue", "profit", "margin", "units", "loss"].includes(String(a.sort)) ? String(a.sort) : "revenue";
  const limit = Math.min(Math.max(Math.floor(Number(a.limit) || 50), 1), 500);
  const rows = p.products
    .filter((x) => (!sku || (x.sku ?? "").toUpperCase() === sku) && (!term || x.name.toLowerCase().includes(term) || (x.sku ?? "").toLowerCase().includes(term)))
    .sort((x, y) => sort === "units" ? y.units - x.units : sort === "profit" ? (y.profit ?? -1e12) - (x.profit ?? -1e12)
      : sort === "margin" ? (y.margin ?? -1e12) - (x.margin ?? -1e12) : sort === "loss" ? (x.profit ?? 1e12) - (y.profit ?? 1e12) : y.revenue - x.revenue)
    .slice(0, limit)
    .map((x) => ({
      sku: x.sku, name: x.name, units_sold: x.units, sales: x.revenue, avg_price: r2(x.avgPrice),
      unit_cost: x.unitCost === null ? null : r2(x.unitCost), cost_source: x.costLabel, cost: x.cost, profit: x.profit,
      margin_pct: x.margin === null ? null : r2(x.margin * 100),
    }));
  return { ...scopeNote(d), sort, products: rows, total_products: p.products.length };
}

export async function stripeCheck(userId: string, a: Record<string, unknown>) {
  const d = await loadProfit(userId, a);
  if (!d.rec) return { ...scopeNote(d), note: "Stripe isn't connected. Connect it in Settings → Sales." };
  const limit = Math.min(Math.max(Math.floor(Number(a.limit) || 25), 1), 200);
  const only = within(d, d.rec.stripeOnly), missing = within(d, d.rec.missingInStripe), diffs = within(d, d.rec.amountDiffs), status = within(d, d.rec.statusDiffs);
  return {
    ...scopeNote(d),
    matched_orders: within(d, d.rec.matched).length,
    stripe_payments_without_store_order: { count: only.length, total: r2(only.reduce((s, x) => s + x.amount, 0)), examples: only.slice(0, limit) },
    store_orders_paid_by_stripe_without_charge: { count: missing.length, examples: missing.slice(0, limit) },
    amount_differences: { count: diffs.length, examples: diffs.slice(0, limit) },
    status_differences: { count: status.length, examples: status.slice(0, limit) },
    disputed_charges: d.rec.disputed,
    note: "Stripe is the source of truth for amounts, refunds and fees; items and sales tax come from the store.",
  };
}

export async function shippingCosts(userId: string, a: Record<string, unknown>) {
  const d = await loadProfit(userId, a);
  if (!d.ship) return { ...scopeNote(d), note: "Easyship isn't connected. Connect it in Settings → Sales." };
  const limit = Math.min(Math.max(Math.floor(Number(a.limit) || 25), 1), 200);
  const orders = within(d, d.ship.orders);
  const charged = r2(orders.reduce((s, o) => s + o.charged, 0)), cost = r2(orders.reduce((s, o) => s + o.cost, 0));
  const losing = orders.filter((o) => o.cost > o.charged + 0.005 && !o.refunded).sort((x, y) => (y.cost - y.charged) - (x.cost - x.charged));
  const labels = within(d, d.ship.expenses);
  return {
    ...scopeNote(d),
    label_spend_total: r2(labels.reduce((s, e) => s + e.amount, 0)),
    matched_orders: orders.length, customers_paid_for_shipping: charged, label_cost_for_those_orders: cost, shipping_profit: r2(charged - cost),
    orders_losing_money_on_shipping: { count: losing.length, total_loss: r2(losing.reduce((s, o) => s + o.cost - o.charged, 0)), worst: losing.slice(0, limit) },
    refunded_orders_already_shipped: orders.filter((o) => o.refunded).slice(0, limit),
    labels_without_store_order: within(d, d.ship.unmatched).slice(0, limit),
    paid_orders_without_label: within(d, d.ship.unshipped).slice(0, limit),
  };
}

export async function inventoryOnHand(userId: string, a: Record<string, unknown>) {
  const d = await loadProfit(userId, { ...a, from: a.as_of ?? a.to, to: a.as_of ?? a.to });
  const s = onHand({
    asOf: d.to, inventoryBuys: d.inventoryBuys, orders: d.orders, saleLines: d.lines, storeStock: d.stock, costOf: d.costOf,
    pools: [...d.stats.values()].map((x) => ({ id: x.pool.id, name: x.pool.name, units: x.units, unit: x.unit })),
  });
  const limit = Math.min(Math.max(Math.floor(Number(a.limit) || 50), 1), 500);
  return {
    as_of: d.to, business: d.businessName ?? "all businesses", units_on_hand: s.units, value_at_cost: s.value,
    rows: s.rows.filter((r) => r.onHand > 0).slice(0, limit).map((r) => ({
      sku: r.sku, name: r.name, counted_by: r.basis === "pool" ? "product line" : r.basis === "store" ? "store stock" : "tagged receipts",
      bought: r.bought, sold: r.sold, on_hand: r.onHand, unit_cost: r2(r.unit), value: r.value, store_stock: r.storeStock,
    })),
    note: "Value at cost can be used as ending inventory (Schedule C line 41).",
  };
}

export async function getOrder(userId: string, a: Record<string, unknown>) {
  const ref = typeof a.order === "string" ? a.order.trim().replace(/^#/, "") : "";
  if (!ref) throw new ProfitError("Pass the store order number in `order`.");
  const db = adminClient();
  const { data: orders } = await db.from("sales_orders")
    .select("id, external_id, order_number, order_date, status, items_total, shipping_charged, tax_collected, refunded, fees, total, payment_method, payment_ref, channel_id")
    .eq("user_id", userId).or(`order_number.eq.${ref},external_id.eq.${ref}`).limit(5);
  if (!orders?.length) throw new ProfitError(`No store order ${ref}.`);
  const o = orders[0];
  const refs = [o.payment_ref, o.external_id].filter(Boolean) as string[];
  const [lines, payments, shipments] = await Promise.all([
    db.from("sales_lines").select("sku, name, quantity, total").eq("order_id", o.id),
    db.from("payments").select("external_id, payment_date, status, amount, refunded, fee, disputed")
      .eq("user_id", userId).or([`order_ref.eq.${o.external_id}`, ...refs.map((r) => `external_id.eq.${r}`), ...refs.map((r) => `payment_intent.eq.${r}`)].join(",")),
    db.from("shipments").select("external_id, ship_date, state, label_cost, courier, tracking").eq("user_id", userId).in("order_ref", [o.order_number ?? o.external_id, o.external_id]),
  ]);
  const d = await loadProfit(userId, { from: o.order_date, to: o.order_date });
  const items = (lines.data ?? []).map((l) => {
    const c = d.costOf(l.sku, l.name);
    const q = Number(l.quantity) || 1;
    return { ...l, unit_cost: c ? r2(c.unit) : null, cost_source: c?.label ?? null, cost: c ? r2(c.unit * q) : null };
  });
  const stripe = (payments.data ?? []).filter((p) => p.status === "succeeded");
  const charged = stripe.length ? stripe.reduce((s, p) => s + Number(p.amount), 0) : Number(o.total);
  const refunded = stripe.length ? stripe.reduce((s, p) => s + Number(p.refunded), 0) : Number(o.refunded);
  const fees = stripe.length ? stripe.reduce((s, p) => s + Number(p.fee), 0) : Number(o.fees);
  const labels = (shipments.data ?? []).filter((s) => s.state === "active").reduce((s, x) => s + Number(x.label_cost), 0);
  const goods = items.reduce((s, i) => s + (i.cost ?? 0), 0);
  return {
    order: o.order_number ?? o.external_id, date: o.order_date, store_status: o.status, payment_method: o.payment_method,
    items, stripe_payments: payments.data ?? [], shipments: shipments.data ?? [],
    money: {
      charged: r2(charged), sales_tax: Number(o.tax_collected), refunded: r2(refunded), fees: r2(fees), cost_of_goods: r2(goods),
      shipping_charged: Number(o.shipping_charged), shipping_labels: r2(labels),
      profit: r2(charged - Number(o.tax_collected) - refunded - fees - goods - labels),
    },
    notes: items.some((i) => i.unit_cost === null) ? ["Some items have no cost yet — set one with set_sku_cost."] : [],
  };
}

export async function setSkuCost(userId: string, a: Record<string, unknown>) {
  const sku = typeof a.sku === "string" ? a.sku.trim().toUpperCase().slice(0, 100) : "";
  if (!sku) throw new ProfitError("Pass the store SKU in `sku`.");
  const clear = a.unit_cost === null;
  const cost = Number(a.unit_cost);
  if (!clear && !(Number.isFinite(cost) && cost >= 0)) throw new ProfitError("unit_cost must be a number ≥ 0 (or null to clear).");
  const { error } = await adminClient().from("sku_costs").upsert(
    { user_id: userId, sku, unit_cost: clear ? null : Math.round(cost * 10000) / 10000, updated_at: new Date().toISOString() }, { onConflict: "user_id,sku" });
  if (error) throw new Error(error.message);
  return clear
    ? { sku, unit_cost: null, note: "Cleared: this SKU goes back to the store, receipt or product-line cost." }
    : { sku, unit_cost: r2(cost), note: "Saved. This cost now overrides the store, receipt and product-line cost for this SKU everywhere in Receipt Catcher." };
}
