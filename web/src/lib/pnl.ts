// Profit & loss from sales (WooCommerce / imported files) and receipts. Pure functions, no React or Supabase,
// so they can be unit-tested. Money is landed cost: each receipt's tax and shipping spread across its items.
//
//   Sales (Schedule C line 1)   = items + shipping charged on paid and refunded orders (sales tax is left out)
//   Returns (line 2)            = refunds
//   Cost of goods sold (line 4) = units sold × average landed cost of that SKU across everything you bought
//   Fees (line 10)              = payment and platform fees recorded on orders
//   Expenses                    = business items on receipts, by Schedule C line (not inventory, not personal)
//   Mileage (line 9)            = saved trips × IRS rate
//   Profit (line 31)            = sales − returns − COGS − fees − expenses − mileage

import { lineLabel, tripValue } from "./writeoffs";

export interface POrder {
  id: string;
  order_date: string;
  status: "paid" | "refunded" | "cancelled" | "pending";
  items_total: number | string;
  shipping_charged: number | string;
  tax_collected: number | string;
  refunded: number | string;
  fees: number | string;
  channel_id: string;
}
export interface PSaleLine { order_id: string; sku: string | null; name: string; quantity: number | string; total: number | string }
export interface PBuyLine {
  id: string;
  description: string;
  woo_sku: string | null;
  units: number | string | null;
  quantity?: number | string | null;
  landed_total: number | string | null;
  tax_line: string | null;
  use_type: string | null;
  business_pct: number | null;
  purchase_date: string | null;
}
export interface PTrip { trip_date: string; miles: number | string }

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
export const skuKey = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const unitsOf = (l: PBuyLine) => n(l.units) || n(l.quantity) || 1;
const counts = (o: POrder) => o.status === "paid" || o.status === "refunded";
const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

export type UnitCost = (sku: string | null, name: string) => { unit: number; source: "manual" | "store" | "receipts" | "pool"; label: string; poolId?: string } | null;

export interface CostBasis { units: number; spend: number; unit: number; name: string; lastBought: string | null }

/** Average landed unit cost per SKU, from every purchase with that SKU up to `asOf`. */
export function costBasis(buys: PBuyLine[], asOf?: string): Map<string, CostBasis> {
  const m = new Map<string, CostBasis>();
  for (const l of buys) {
    const k = skuKey(l.woo_sku);
    if (!k || (asOf && l.purchase_date && l.purchase_date > asOf)) continue;
    const c = m.get(k) ?? { units: 0, spend: 0, unit: 0, name: l.description, lastBought: null };
    c.units += unitsOf(l);
    c.spend += n(l.landed_total);
    if (!c.lastBought || (l.purchase_date ?? "") > c.lastBought) { c.lastBought = l.purchase_date; c.name = l.description; }
    m.set(k, c);
  }
  for (const c of m.values()) c.unit = c.units ? c.spend / c.units : 0;
  return m;
}

export interface ProductRow {
  key: string;
  sku: string | null;
  name: string;
  units: number;
  revenue: number;
  cost: number | null; // null = no purchases with this SKU
  profit: number | null;
  margin: number | null; // 0..1
  avgPrice: number;
  unitCost: number | null;
  /** Where the unit cost came from: your cost, the store, receipts, or a product line (pool). */
  costSource: "manual" | "store" | "receipts" | "pool" | null;
  costLabel: string | null;
}

export interface MonthRow { month: string; sales: number; cogs: number; fees: number; expenses: number; profit: number }

export interface Pnl {
  orders: number;
  units: number;
  gross: number; // line 1
  returns: number; // line 2
  netSales: number;
  cogs: number; // line 4
  grossProfit: number;
  fees: number; // line 10
  expenses: { line: string; label: string; amount: number }[];
  expenseTotal: number;
  mileage: number;
  profit: number; // line 31
  margin: number | null;
  taxCollected: number;
  /** Sold units we couldn't cost: no purchase has that SKU. */
  unmatched: { key: string; sku: string | null; name: string; units: number; revenue: number }[];
  unmatchedRevenue: number;
  products: ProductRow[];
  months: MonthRow[];
}

/** Business share of a receipt item, or null when it isn't a business expense (inventory is costed separately). */
export function expenseAmount(l: PBuyLine): number | null {
  if (l.tax_line === "cogs" || l.woo_sku || !l.tax_line || l.tax_line === "personal" || l.use_type === "personal") return null;
  let v = n(l.landed_total);
  if (v <= 0) return null;
  if (l.use_type === "mixed") v = (v * (l.business_pct ?? 0)) / 100;
  if (l.tax_line === "c24b") v *= 0.5; // meals
  return v > 0 ? v : null;
}

export function buildPnl(args: {
  from: string;
  to: string;
  orders: POrder[];
  saleLines: PSaleLine[];
  /** All SKU'd purchases up to `to` (any year) — the cost basis. */
  inventoryBuys: PBuyLine[];
  /** Receipt items dated within the period — for expenses. */
  periodBuys: PBuyLine[];
  trips: PTrip[];
  /** Costs from connected services, e.g. shipping labels from Easyship: { key, label, date, amount }. */
  otherExpenses?: { key: string; label: string; date: string; amount: number }[];
  /** Unit cost per sold product (see costs.ts). Defaults to receipts tagged with the SKU. */
  costOf?: UnitCost;
}): Pnl {
  const { from, to } = args;
  const basis = costBasis(args.inventoryBuys, to);
  const costOf: UnitCost = args.costOf ?? ((sku) => {
    const b = sku ? basis.get(skuKey(sku)) : undefined;
    return b ? { unit: b.unit, source: "receipts", label: "Receipts" } : null;
  });
  const orders = args.orders.filter((o) => counts(o) && inRange(o.order_date, from, to));
  const byId = new Map(orders.map((o) => [o.id, o]));
  const months = new Map<string, MonthRow>();
  const month = (d: string) => {
    const k = d.slice(0, 7);
    let m = months.get(k);
    if (!m) months.set(k, (m = { month: k, sales: 0, cogs: 0, fees: 0, expenses: 0, profit: 0 }));
    return m;
  };

  let gross = 0, returns = 0, fees = 0, tax = 0;
  for (const o of orders) {
    const g = n(o.items_total) + n(o.shipping_charged);
    gross += g;
    returns += n(o.refunded);
    fees += n(o.fees);
    tax += n(o.tax_collected);
    const m = month(o.order_date);
    m.sales += g - n(o.refunded);
    m.fees += n(o.fees);
  }

  // Cost of what was sold. Fully refunded orders are assumed returned to stock.
  let cogs = 0, units = 0;
  const prod = new Map<string, ProductRow>();
  for (const l of args.saleLines) {
    const o = byId.get(l.order_id);
    if (!o) continue;
    const q = n(l.quantity) || 1;
    const k = skuKey(l.sku) || `name:${l.name.trim().toLowerCase()}`;
    const p = prod.get(k) ?? { key: k, sku: l.sku?.trim() || null, name: l.name, units: 0, revenue: 0, cost: 0, profit: null, margin: null, avgPrice: 0, unitCost: null, costSource: null, costLabel: null };
    const b = costOf(l.sku, l.name);
    if (o.status === "paid") {
      p.units += q;
      units += q;
      p.revenue += n(l.total);
      if (b) {
        p.cost = (p.cost ?? 0) + q * b.unit;
        cogs += q * b.unit;
        month(o.order_date).cogs += q * b.unit;
      } else p.cost = null;
      p.unitCost = b ? b.unit : null;
      p.costSource = b ? b.source : null;
      p.costLabel = b ? b.label : null;
    }
    prod.set(k, p);
  }
  const products = [...prod.values()].filter((p) => p.units > 0).map((p) => {
    const cost = p.cost === null ? null : r2(p.cost);
    const profit = cost === null ? null : r2(p.revenue - cost);
    return { ...p, revenue: r2(p.revenue), cost, profit, margin: profit !== null && p.revenue > 0 ? profit / p.revenue : null, avgPrice: p.units ? p.revenue / p.units : 0 };
  }).sort((a, b) => b.revenue - a.revenue);
  const unmatched = products.filter((p) => p.cost === null).map(({ key, sku, name, units, revenue }) => ({ key, sku, name, units, revenue }));

  // Business expenses on receipts, by Schedule C line.
  const exp = new Map<string, number>();
  for (const l of args.periodBuys) {
    if (!inRange(l.purchase_date, from, to)) continue;
    const v = expenseAmount(l);
    if (v === null) continue;
    exp.set(l.tax_line!, (exp.get(l.tax_line!) ?? 0) + v);
    month(l.purchase_date!).expenses += v;
  }
  const labels = new Map<string, string>();
  for (const e of args.otherExpenses ?? []) {
    if (!inRange(e.date, from, to) || !e.amount) continue;
    labels.set(e.key, e.label);
    exp.set(e.key, (exp.get(e.key) ?? 0) + e.amount);
    month(e.date).expenses += e.amount;
  }
  const expenses = [...exp].map(([line, amount]) => ({ line, label: labels.get(line) ?? lineLabel(line), amount: r2(amount) })).sort((a, b) => b.amount - a.amount);
  const expenseTotal = r2(expenses.reduce((a, e) => a + e.amount, 0));

  let mileage = 0;
  for (const t of args.trips) {
    if (!inRange(t.trip_date, from, to)) continue;
    const v = tripValue({ trip_date: t.trip_date, miles: n(t.miles) });
    mileage += v;
    month(t.trip_date).expenses += v;
  }

  const netSales = r2(gross - returns);
  const grossProfit = r2(netSales - cogs);
  const profit = r2(grossProfit - fees - expenseTotal - mileage);
  for (const m of months.values()) {
    m.sales = r2(m.sales); m.cogs = r2(m.cogs); m.fees = r2(m.fees); m.expenses = r2(m.expenses);
    m.profit = r2(m.sales - m.cogs - m.fees - m.expenses);
  }
  return {
    orders: orders.filter((o) => n(o.items_total) + n(o.shipping_charged) > 0).length, units, gross: r2(gross), returns: r2(returns), netSales, cogs: r2(cogs), grossProfit, fees: r2(fees),
    expenses, expenseTotal, mileage: r2(mileage), profit, margin: netSales > 0 ? profit / netSales : null, taxCollected: r2(tax),
    unmatched, unmatchedRevenue: r2(unmatched.reduce((a, u) => a + u.revenue, 0)), products,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

export interface OnHandRow {
  key: string;
  sku: string | null;
  name: string;
  /** "receipts": a SKU's tagged purchases; "pool": a product line; "store": a costed SKU counted by the store's stock. */
  basis: "receipts" | "pool" | "store";
  bought: number | null;
  sold: number | null;
  onHand: number;
  unit: number;
  value: number;
  storeStock: number | null;
}

/**
 * Inventory on hand at `asOf`, valued at cost:
 *  - SKUs with tagged receipts: bought − sold;
 *  - product lines (pools): untagged purchases in the line − units sold that were costed from that line;
 *  - SKUs costed by your cost or the store's cost with no receipts: the store's own stock count.
 * `storeStock` is what the store reports, for comparison.
 */
export function onHand(args: {
  asOf: string;
  inventoryBuys: PBuyLine[];
  orders: POrder[];
  saleLines: PSaleLine[];
  storeStock?: Map<string, number>;
  costOf?: UnitCost;
  /** Product lines with their purchased units, from costs.ts poolStats. */
  pools?: { id: string; name: string; units: number; unit: number | null }[];
}): { rows: OnHandRow[]; value: number; units: number } {
  const basis = costBasis(args.inventoryBuys, args.asOf);
  const paid = new Map(args.orders.filter((o) => o.status === "paid" && o.order_date <= args.asOf).map((o) => [o.id, o]));
  const sold = new Map<string, number>();
  const soldFromPool = new Map<string, number>();
  const costed = new Map<string, { unit: number; name: string }>();
  for (const l of args.saleLines) {
    if (!paid.has(l.order_id)) continue;
    const q = n(l.quantity) || 1;
    if (l.sku) sold.set(skuKey(l.sku), (sold.get(skuKey(l.sku)) ?? 0) + q);
    const c = args.costOf?.(l.sku, l.name);
    if (c?.source === "pool" && c.poolId) soldFromPool.set(c.poolId, (soldFromPool.get(c.poolId) ?? 0) + q);
    if (c && (c.source === "manual" || c.source === "store") && l.sku) costed.set(skuKey(l.sku), { unit: c.unit, name: l.name });
  }
  const rows: OnHandRow[] = [];
  for (const [sku, b] of basis) {
    const s = sold.get(sku) ?? 0;
    const left = Math.max(0, b.units - s);
    const c = args.costOf?.(sku, b.name);
    const unit = c ? c.unit : b.unit;
    rows.push({ key: sku, sku, name: b.name, basis: "receipts", bought: b.units, sold: s, onHand: left, unit, value: r2(left * unit), storeStock: args.storeStock?.get(sku) ?? null });
  }
  for (const p of args.pools ?? []) {
    if (p.unit == null || !p.units) continue;
    const s = soldFromPool.get(p.id) ?? 0;
    const left = Math.max(0, p.units - s);
    rows.push({ key: `pool:${p.id}`, sku: null, name: p.name, basis: "pool", bought: p.units, sold: s, onHand: left, unit: p.unit, value: r2(left * p.unit), storeStock: null });
  }
  // Manually or store-costed SKUs without receipts: count what the store says it still has.
  for (const [sku, stock] of args.storeStock ?? []) {
    if (basis.has(sku) || stock <= 0) continue;
    const c = costed.get(sku) ?? (() => {
      const x = args.costOf?.(sku, "");
      return x && (x.source === "manual" || x.source === "store") ? { unit: x.unit, name: sku } : undefined;
    })();
    if (!c) continue;
    rows.push({ key: sku, sku, name: c.name, basis: "store", bought: null, sold: sold.get(sku) ?? 0, onHand: stock, unit: c.unit, value: r2(stock * c.unit), storeStock: stock });
  }
  rows.sort((a, b) => b.value - a.value);
  return { rows, value: r2(rows.reduce((a, r) => a + r.value, 0)), units: rows.reduce((a, r) => a + r.onHand, 0) };
}
