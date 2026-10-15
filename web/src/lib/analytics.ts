// Spending analytics for the Receipts page: headline numbers, spend by month, stores and items.
// Pure functions over rows already loaded in the browser (the receipts and the inventory_lines view).

export type Kind = "inventory" | "business" | "personal" | "unsorted";
export const KINDS: Kind[] = ["inventory", "business", "personal", "unsorted"];
export const KIND_LABEL: Record<Kind, string> = {
  inventory: "Inventory",
  business: "Business expenses",
  personal: "Personal",
  unsorted: "Not sorted yet",
};

export interface AReceipt {
  id: string;
  merchant: string | null;
  purchase_date: string | null;
  total: number | null;
  document_type: string;
  status: string;
  business_id?: string | null;
  category_id?: string | null;
}

export interface ALine {
  id: string;
  receipt_id: string;
  description: string;
  woo_sku: string | null;
  store_sku?: string | null;
  quantity: number | null;
  units: number | null;
  landed_total: number | null;
  tax_line: string | null;
  use_type: string | null;
  business_pct: number | null;
  merchant: string | null;
  purchase_date: string | null;
}

const num = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a line is, for the spend breakdown. Mixed items split by their business %. */
export function classify(l: Pick<ALine, "tax_line" | "use_type" | "business_pct">): [Kind, number][] {
  if (l.tax_line === "cogs") return [["inventory", 1]];
  if (l.tax_line === "personal" || l.use_type === "personal") return [["personal", 1]];
  if (l.use_type === "mixed") {
    const pct = (l.business_pct ?? 50) / 100;
    return [["business", pct], ["personal", 1 - pct]];
  }
  if (l.use_type === "business" || l.tax_line) return [["business", 1]];
  return [["unsorted", 1]];
}

export const signed = (r: Pick<AReceipt, "total" | "document_type">) => (r.document_type === "refund" ? -num(r.total) : num(r.total));

/** Display name and grouping key for a store ("Walmart.com" and "WALMART" are the same store). */
export function storeKey(merchant: string | null): string {
  return (merchant ?? "").toLowerCase().replace(/\.(com|net|co)\b/g, "").replace(/[^a-z0-9]/g, "") || "unknown";
}

/** Same product bought on different receipts: by Woo SKU, else store SKU, else a normalised description. */
export function itemKey(l: Pick<ALine, "woo_sku" | "store_sku" | "description">): string {
  if (l.woo_sku) return `sku:${l.woo_sku.toLowerCase()}`;
  if (l.store_sku) return `store:${l.store_sku.toLowerCase()}`;
  return "d:" + l.description.toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9.:/]+/g, " ").trim();
}

export interface Period { from: string | null; to: string | null; label: string; prev: { from: string; to: string } | null }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const PERIODS = ["month", "3m", "year", "lastyear", "12m", "all"] as const;
export type PeriodKey = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  month: "This month", "3m": "Last 3 months", year: "This year", lastyear: "Last year", "12m": "Last 12 months", all: "All time",
};

/** Date range for a period and the same-length range just before it (for "vs previous"). */
export function periodRange(key: PeriodKey, today = new Date()): Period {
  const y = today.getFullYear(), m = today.getMonth();
  const make = (from: Date, to: Date, prevFrom: Date, prevTo: Date): Period => ({
    from: iso(from), to: iso(to), label: PERIOD_LABEL[key], prev: { from: iso(prevFrom), to: iso(prevTo) },
  });
  switch (key) {
    case "month": return make(new Date(y, m, 1), today, new Date(y, m - 1, 1), new Date(y, m - 1, Math.min(today.getDate(), new Date(y, m, 0).getDate())));
    case "3m": return make(new Date(y, m - 2, 1), today, new Date(y, m - 5, 1), new Date(y, m - 2, 0));
    case "year": return make(new Date(y, 0, 1), today, new Date(y - 1, 0, 1), new Date(y - 1, m, today.getDate()));
    case "lastyear": return make(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31), new Date(y - 2, 0, 1), new Date(y - 2, 11, 31));
    case "12m": return make(new Date(y, m - 11, 1), today, new Date(y, m - 23, 1), new Date(y, m - 11, 0));
    default: return { from: null, to: null, label: PERIOD_LABEL.all, prev: null };
  }
}

export const inRange = (d: string | null, from: string | null, to: string | null) =>
  !!d && (!from || d >= from) && (!to || d <= to);

export interface Kpis {
  spend: number;
  receipts: number;
  avgOrder: number;
  byKind: Record<Kind, number>;
  stores: number;
}

export function kpis(receipts: AReceipt[], lines: ALine[]): Kpis {
  const byKind: Record<Kind, number> = { inventory: 0, business: 0, personal: 0, unsorted: 0 };
  for (const l of lines) for (const [k, share] of classify(l)) byKind[k] += num(l.landed_total) * share;
  const purchases = receipts.filter((r) => r.document_type !== "refund");
  const spend = receipts.reduce((a, r) => a + signed(r), 0);
  // Receipts without itemised lines still count, as unsorted.
  const itemised = KINDS.reduce((a, k) => a + byKind[k], 0);
  if (spend > itemised) byKind.unsorted += spend - itemised;
  for (const k of KINDS) byKind[k] = round2(byKind[k]);
  return {
    spend: round2(spend),
    receipts: purchases.length,
    avgOrder: purchases.length ? round2(purchases.reduce((a, r) => a + num(r.total), 0) / purchases.length) : 0,
    byKind,
    stores: new Set(receipts.map((r) => storeKey(r.merchant))).size,
  };
}

/** % change, or null when there's nothing to compare with. */
export const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

export interface MonthRow { month: string; total: number; byKind: Record<Kind, number> }

/** Spend per calendar month by kind, oldest first, including empty months in between. */
export function byMonth(receipts: AReceipt[], lines: ALine[]): MonthRow[] {
  const rows = new Map<string, MonthRow>();
  const row = (d: string) => {
    const k = d.slice(0, 7);
    if (!rows.has(k)) rows.set(k, { month: k, total: 0, byKind: { inventory: 0, business: 0, personal: 0, unsorted: 0 } });
    return rows.get(k)!;
  };
  const itemised = new Map<string, number>();
  for (const l of lines) {
    if (!l.purchase_date) continue;
    for (const [k, share] of classify(l)) row(l.purchase_date).byKind[k] += num(l.landed_total) * share;
    itemised.set(l.receipt_id, (itemised.get(l.receipt_id) ?? 0) + num(l.landed_total));
  }
  for (const r of receipts) {
    if (!r.purchase_date) continue;
    const m = row(r.purchase_date);
    m.total += signed(r);
    const rest = signed(r) - (itemised.get(r.id) ?? 0);
    if (rest > 0.005) m.byKind.unsorted += rest;
  }
  const sorted = [...rows.values()].sort((a, b) => a.month.localeCompare(b.month));
  if (!sorted.length) return [];
  // Fill gaps so the bars sit on a continuous time axis.
  const out: MonthRow[] = [];
  let [y, mo] = sorted[0].month.split("-").map(Number);
  const last = sorted[sorted.length - 1].month;
  for (;;) {
    const k = `${y}-${String(mo).padStart(2, "0")}`;
    out.push(rows.get(k) ?? { month: k, total: 0, byKind: { inventory: 0, business: 0, personal: 0, unsorted: 0 } });
    if (k === last) break;
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return out.map((r) => ({ ...r, total: round2(r.total), byKind: Object.fromEntries(KINDS.map((k) => [k, round2(r.byKind[k])])) as Record<Kind, number> }));
}

export interface StoreStat {
  key: string;
  name: string;
  spend: number;
  orders: number;
  avgBasket: number;
  lastVisit: string | null;
  firstVisit: string | null;
  businessShare: number; // 0..1 of itemised spend that is inventory or business
  byKind: Record<Kind, number>;
  topItems: { name: string; spend: number; count: number }[];
}

export function storeStats(receipts: AReceipt[], lines: ALine[]): StoreStat[] {
  const stores = new Map<string, StoreStat & { names: Map<string, number>; items: Map<string, { name: string; spend: number; count: number }> }>();
  const get = (merchant: string | null) => {
    const key = storeKey(merchant);
    if (!stores.has(key)) {
      stores.set(key, {
        key, name: merchant ?? "Unknown store", spend: 0, orders: 0, avgBasket: 0, lastVisit: null, firstVisit: null, businessShare: 0,
        byKind: { inventory: 0, business: 0, personal: 0, unsorted: 0 }, topItems: [], names: new Map(), items: new Map(),
      });
    }
    const s = stores.get(key)!;
    if (merchant) s.names.set(merchant, (s.names.get(merchant) ?? 0) + 1);
    return s;
  };
  for (const r of receipts) {
    const s = get(r.merchant);
    s.spend += signed(r);
    if (r.document_type !== "refund") s.orders++;
    if (r.purchase_date) {
      if (!s.lastVisit || r.purchase_date > s.lastVisit) s.lastVisit = r.purchase_date;
      if (!s.firstVisit || r.purchase_date < s.firstVisit) s.firstVisit = r.purchase_date;
    }
  }
  for (const l of lines) {
    const s = get(l.merchant);
    for (const [k, share] of classify(l)) s.byKind[k] += num(l.landed_total) * share;
    const ik = itemKey(l);
    const it = s.items.get(ik) ?? { name: l.description, spend: 0, count: 0 };
    it.spend += num(l.landed_total);
    it.count += 1;
    s.items.set(ik, it);
  }
  return [...stores.values()].map(({ names, items, ...s }) => {
    const itemised = KINDS.reduce((a, k) => a + s.byKind[k], 0);
    return {
      ...s,
      // Most common spelling of the store's name.
      name: [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.name,
      spend: round2(s.spend),
      avgBasket: s.orders ? round2(s.spend / s.orders) : 0,
      businessShare: itemised > 0 ? (s.byKind.inventory + s.byKind.business) / itemised : 0,
      topItems: [...items.values()].sort((a, b) => b.spend - a.spend).slice(0, 3).map((t) => ({ ...t, spend: round2(t.spend) })),
    };
  }).sort((a, b) => b.spend - a.spend);
}

export interface ItemStat {
  key: string;
  name: string;
  sku: string | null;
  kind: Kind;
  purchases: number;
  units: number;
  spend: number;
  avgUnit: number | null;
  lowUnit: number | null;
  lowStore: string | null;
  lastUnit: number | null;
  lastBought: string | null;
  stores: string[];
  receiptIds: string[];
}

/** Every product bought, merged across receipts, with unit costs (landed: tax and shipping spread in). */
export function itemStats(lines: ALine[]): ItemStat[] {
  const groups = new Map<string, ALine[]>();
  for (const l of lines) groups.set(itemKey(l), [...(groups.get(itemKey(l)) ?? []), l]);
  const out: ItemStat[] = [];
  for (const [key, ls] of groups) {
    ls.sort((a, b) => (a.purchase_date ?? "").localeCompare(b.purchase_date ?? ""));
    const units = ls.reduce((a, l) => a + (num(l.units) || num(l.quantity) || 1), 0);
    const spend = ls.reduce((a, l) => a + num(l.landed_total), 0);
    let low: { cost: number; store: string | null } | null = null;
    for (const l of ls) {
      const u = num(l.units) || num(l.quantity) || 1;
      if (l.landed_total == null) continue;
      const cost = num(l.landed_total) / u;
      if (!low || cost < low.cost) low = { cost, store: l.merchant };
    }
    const last = ls[ls.length - 1];
    const lastU = num(last.units) || num(last.quantity) || 1;
    const kinds = ls.map((l) => classify(l)[0][0]);
    const kind = (KINDS.find((k) => kinds.filter((x) => x === k).length > kinds.length / 2) ?? kinds[kinds.length - 1]) as Kind;
    out.push({
      key,
      name: last.description,
      sku: ls.find((l) => l.woo_sku)?.woo_sku ?? null,
      kind,
      purchases: ls.length,
      units: round2(units),
      spend: round2(spend),
      avgUnit: units ? round2(spend / units) : null,
      lowUnit: low ? round2(low.cost) : null,
      lowStore: low?.store ?? null,
      lastUnit: last.landed_total != null ? round2(num(last.landed_total) / lastU) : null,
      lastBought: last.purchase_date,
      // One name per store, however it was spelled on each receipt.
      stores: [...new Map(ls.filter((l) => l.merchant).map((l) => [storeKey(l.merchant), l.merchant!] as const).reverse()).values()].reverse(),
      receiptIds: [...new Set(ls.map((l) => l.receipt_id))],
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
}
