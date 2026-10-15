// Unit cost per product for cost of goods, from the most specific source available:
//   1. your cost for the SKU (sku_costs.unit_cost)       → "manual"
//   2. a cost kept in the store (sales_products.cost)    → "store"
//   3. receipts tagged with the SKU (line_items.woo_sku) → "receipts"
//   4. a product line (cost pool): pinned SKU, else the first pool whose product words match the name → "pool"
// Pool cost is its own unit_cost if set, else the average landed cost of untagged inventory receipts whose description
// matches its purchase words. Setting a SKU's cost later simply wins over the pool. Pure, for tests.

import { skuKey, type PBuyLine } from "./pnl";

export interface CostPool {
  id: string;
  name: string;
  purchase_words: string[];
  product_words: string[];
  unit_cost: number | string | null;
  position: number;
}
export interface SkuCost { sku: string; unit_cost: number | string | null; pool_id: string | null }

export type CostSource = "manual" | "store" | "receipts" | "pool";
export interface CostInfo { unit: number; source: CostSource; poolId?: string; label: string }
export interface PoolStat { pool: CostPool; units: number; spend: number; purchases: number; avg: number | null; unit: number | null }

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const has = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/** Lowercase words; "Hot Wheels" and "HotWheels" both become "hotwheels" so phrases match either spelling. */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/hot\s*wheels?/g, "hotwheels").replace(/['’]/g, "").split(/[^a-z0-9:]+/).filter(Boolean);
}

/** True when the text contains every word of at least one phrase. */
export function matches(text: string, phrases: string[]): boolean {
  const have = new Set(words(text));
  return phrases.some((p) => {
    const need = words(p);
    return need.length > 0 && need.every((w) => have.has(w));
  });
}

const byPosition = (pools: CostPool[]) => [...pools].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

export function poolForProduct(name: string, pools: CostPool[]): CostPool | null {
  return byPosition(pools).find((p) => matches(name, p.product_words)) ?? null;
}
export function poolForPurchase(description: string, pools: CostPool[]): CostPool | null {
  return byPosition(pools).find((p) => matches(description, p.purchase_words)) ?? null;
}

const unitsOf = (l: PBuyLine) => n(l.units) || n(l.quantity) || 1;

/** Each pool's purchases (untagged inventory receipts up to `asOf`) and resulting unit cost. */
export function poolStats(pools: CostPool[], buys: PBuyLine[], asOf?: string): Map<string, PoolStat> {
  const out = new Map(pools.map((p) => [p.id, { pool: p, units: 0, spend: 0, purchases: 0, avg: null, unit: null } as PoolStat]));
  for (const l of buys) {
    if (l.woo_sku || (asOf && l.purchase_date && l.purchase_date > asOf)) continue;
    const p = poolForPurchase(l.description, pools);
    if (!p) continue;
    const s = out.get(p.id)!;
    s.units += unitsOf(l);
    s.spend += n(l.landed_total);
    s.purchases++;
  }
  for (const s of out.values()) {
    s.avg = s.units ? s.spend / s.units : null;
    s.unit = has(s.pool.unit_cost) ? n(s.pool.unit_cost) : s.avg;
  }
  return out;
}

export interface CostInputs {
  pools: CostPool[];
  skuCosts: SkuCost[];
  /** Store cost and catalog name by SKU. */
  storeProducts: { sku: string; name: string; cost?: number | string | null }[];
  /** Average landed cost of receipts tagged with each SKU. */
  receiptBasis: Map<string, { unit: number }>;
  stats: Map<string, PoolStat>;
}

/** Returns a function giving the unit cost of a sold product (by SKU, then name) or null when nothing covers it. */
export function costResolver(c: CostInputs): (sku: string | null, name: string) => CostInfo | null {
  const manual = new Map(c.skuCosts.map((s) => [skuKey(s.sku), s]));
  const store = new Map(c.storeProducts.map((p) => [skuKey(p.sku), p]));
  const poolById = new Map(c.pools.map((p) => [p.id, p]));
  const fromPool = (p: CostPool | null | undefined): CostInfo | null => {
    const u = p ? c.stats.get(p.id)?.unit : null;
    return p && u != null ? { unit: u, source: "pool", poolId: p.id, label: p.name } : null;
  };
  return (sku, name) => {
    const k = skuKey(sku);
    const m = k ? manual.get(k) : undefined;
    if (m && has(m.unit_cost)) return { unit: n(m.unit_cost), source: "manual", label: "Your cost" };
    const sp = k ? store.get(k) : undefined;
    if (sp && has(sp.cost) && n(sp.cost) > 0) return { unit: n(sp.cost), source: "store", label: "Store cost" };
    const r = k ? c.receiptBasis.get(k) : undefined;
    if (r) return { unit: r.unit, source: "receipts", label: "Receipts" };
    if (m?.pool_id) return fromPool(poolById.get(m.pool_id));
    return fromPool(poolForProduct(`${sp?.name ?? ""} ${name}`, c.pools));
  };
}

/** Product lines worth suggesting: known collectible lines that appear in both your receipts and your store. */
const LINES: { name: string; words: string[] }[] = [
  { name: "Hot Wheels Car Culture", words: ["car culture"] },
  { name: "Hot Wheels Team Transport", words: ["team transport"] },
  { name: "Hot Wheels Boulevard", words: ["boulevard"] },
  { name: "Hot Wheels Premium", words: ["hot wheels premium", "pop culture", "replica entertainment"] },
  { name: "Hot Wheels Red Line Club", words: ["red line club", "rlc"] },
  { name: "Hot Wheels Monster Trucks", words: ["hot wheels monster trucks", "hot wheels monster truck"] },
  { name: "Monster Jam", words: ["monster jam"] },
  { name: "Matchbox Moving Parts", words: ["moving parts"] },
  { name: "Matchbox Collectors", words: ["matchbox collectors"] },
  { name: "M2 Machines", words: ["m2 machines", "m2"] },
  { name: "Greenlight", words: ["greenlight"] },
  { name: "Johnny Lightning", words: ["johnny lightning"] },
  { name: "Mini GT", words: ["mini gt"] },
  { name: "Auto World", words: ["auto world", "autoworld"] },
  { name: "Majorette", words: ["majorette"] },
  { name: "Matchbox", words: ["matchbox"] },
  { name: "Hot Wheels mainline", words: ["hot wheels"] },
];

export interface PoolSuggestion { name: string; words: string[]; purchases: number; products: number }

/** Suggested pools, most specific first (their order becomes the match order). */
export function suggestPools(purchaseNames: string[], productNames: string[]): PoolSuggestion[] {
  const out: PoolSuggestion[] = [];
  const taken = { buy: new Set<number>(), sell: new Set<number>() };
  for (const line of LINES) {
    const buy = purchaseNames.map((s, i) => [s, i] as const).filter(([s, i]) => !taken.buy.has(i) && matches(s, line.words));
    const sell = productNames.map((s, i) => [s, i] as const).filter(([s, i]) => !taken.sell.has(i) && matches(s, line.words));
    if (!buy.length || !sell.length) continue;
    buy.forEach(([, i]) => taken.buy.add(i));
    sell.forEach(([, i]) => taken.sell.add(i));
    out.push({ name: line.name, words: line.words, purchases: buy.length, products: sell.length });
  }
  return out;
}

/** "sku,cost" rows from a pasted or uploaded file; header row and $ signs allowed. */
export function parseSkuCosts(text: string): { rows: { sku: string; unit_cost: number }[]; skipped: number } {
  const rows: { sku: string; unit_cost: number }[] = [];
  let skipped = 0;
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [a, b] = line.split(/[,\t;]/).map((x) => x.trim().replace(/^"|"$/g, ""));
    const cost = parseFloat((b ?? "").replace(/[$,\s]/g, ""));
    if (!a || !Number.isFinite(cost) || cost < 0) { skipped++; continue; }
    rows.push({ sku: a.toUpperCase().slice(0, 100), unit_cost: Math.round(cost * 10000) / 10000 });
  }
  // A header like "sku,cost" doesn't parse as a number, so it lands in skipped; don't count it against the user.
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  if (/sku/i.test(first) && skipped) skipped--;
  const last = new Map(rows.map((r) => [r.sku, r]));
  return { rows: [...last.values()], skipped };
}
