// Turns a marketplace's sales export (eBay, Etsy, Shopify or any CSV) into orders and items for sales_orders /
// sales_lines. Pure: parsing happens in the browser and only totals, dates, SKUs and item names are kept —
// buyer names and addresses in the file are never read into the result.

export type Preset = "ebay" | "etsy" | "shopify" | "generic";

export const PRESETS: Record<Preset, { label: string; channel: string; how: string }> = {
  ebay: {
    label: "eBay transaction report", channel: "eBay",
    how: "Seller Hub → Payments → Reports → Transaction report → Download (CSV). Includes fees and refunds.",
  },
  etsy: {
    label: "Etsy sold order items", channel: "Etsy",
    how: "Shop Manager → Settings → Options → Download Data → Orders: Order Items (CSV). Etsy fees are on your monthly statement.",
  },
  shopify: {
    label: "Shopify orders", channel: "Shopify",
    how: "Shopify admin → Orders → Export → All orders, CSV for Excel.",
  },
  generic: { label: "Other (pick the columns)", channel: "Imported sales", how: "Any CSV with one row per item sold." },
};

export type Field = "order" | "date" | "name" | "sku" | "quantity" | "total" | "shipping" | "tax" | "fees" | "refund" | "status";
export const FIELD_LABEL: Record<Field, string> = {
  order: "Order number", date: "Date", name: "Item name", sku: "SKU", quantity: "Quantity", total: "Item total (price × qty)",
  shipping: "Shipping charged", tax: "Sales tax", fees: "Fees", refund: "Refunded", status: "Status",
};
export type Mapping = Partial<Record<Field, string>>;

export interface ImportOrder {
  external_id: string;
  order_number: string;
  order_date: string;
  status: "paid" | "refunded" | "cancelled" | "pending";
  items_total: number;
  shipping_charged: number;
  tax_collected: number;
  refunded: number;
  fees: number;
  total: number;
  lines: { sku: string | null; name: string; quantity: number; total: number }[];
}

export interface ImportResult {
  orders: ImportOrder[];
  skipped: number;
  warnings: string[];
  from: string | null;
  to: string | null;
}

/* ---------------- CSV ---------------- */

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, a BOM, ; or tab separators. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.indexOf("\n") >>> 0);
  const sep = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Header row index: the first row that has all `needed` columns (eBay puts a few summary lines above it). */
function headerRow(rows: string[][], needed: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const hs = rows[i].map(norm);
    if (needed.every((n) => hs.includes(n))) return i;
  }
  return -1;
}

export function detectPreset(rows: string[][]): Preset {
  if (headerRow(rows, ["type", "order number"]) >= 0 && headerRow(rows, ["gross transaction amount"]) >= 0) return "ebay";
  if (headerRow(rows, ["sale date", "item name", "order id"]) >= 0) return "etsy";
  if (headerRow(rows, ["name", "financial status", "lineitem name"]) >= 0) return "shopify";
  return "generic";
}

/* ---------------- values ---------------- */

export function money(v: string | undefined): number {
  if (!v) return 0;
  const s = v.trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^[^\d(-]+/, ""));
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const year4 = (y: number) => (y < 100 ? 2000 + y : y);

/** 2026-01-05, 01/05/2026, 1/5/26, Jan-05-26, Jan 5, 2026, 05-Jan-2026, 2026-01-05 10:22:01 -0500 → 2026-01-05. */
export function parseDate(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${year4(+m[3])}-${pad(+m[1])}-${pad(+m[2])}`;
  m = s.match(/^([A-Za-z]{3})[a-z]*[-\s](\d{1,2}),?[-\s](\d{2,4})/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${year4(+m[3])}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(+m[2])}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return `${year4(+m[3])}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`;
  return null;
}

/* ---------------- presets ---------------- */

interface Row { order: string; date: string | null; kind: "line" | "refund" | "fee"; status?: ImportOrder["status"];
  name?: string; sku?: string | null; quantity?: number; total?: number;
  // Order-level amounts: files repeat them on every item row or put them on the first, so the max is taken.
  shipping?: number; tax?: number; fees?: number; refund?: number; discount?: number }

type Get = (row: string[], ...names: string[]) => string | undefined;

function getter(header: string[]): Get {
  const idx = new Map(header.map((h, i) => [norm(h), i] as const));
  return (row, ...names) => {
    for (const n of names) {
      const i = idx.get(norm(n));
      if (i !== undefined && row[i] !== undefined && row[i].trim() !== "" && row[i].trim() !== "--") return row[i].trim();
    }
    return undefined;
  };
}

function ebay(rows: string[][]): Row[] | string {
  const h = headerRow(rows, ["type", "order number"]);
  if (h < 0) return "This doesn't look like an eBay transaction report (no Type / Order number columns).";
  const get = getter(rows[h]);
  const out: Row[] = [];
  for (const r of rows.slice(h + 1)) {
    const type = (get(r, "Type") ?? "").toLowerCase();
    const date = parseDate(get(r, "Transaction creation date", "Date"));
    const order = get(r, "Order number") ?? "";
    const fee = ["Final Value Fee - fixed", "Final Value Fee - variable", "Regulatory operating fee", "Very high \"item not as described\" fee",
      "Below standard performance fee", "International fee", "Charity donation"].reduce((a, k) => a + Math.abs(money(get(r, k))), 0);
    if (type === "order") {
      out.push({ order, date, kind: "line", name: get(r, "Item title") ?? "eBay item", sku: get(r, "Custom label") ?? null,
        quantity: money(get(r, "Quantity")) || 1, total: money(get(r, "Item subtotal")),
        shipping: money(get(r, "Shipping and handling")), tax: money(get(r, "Seller collected tax")), fees: fee });
    } else if (type === "refund") {
      out.push({ order, date, kind: "refund", refund: Math.abs(money(get(r, "Gross transaction amount"))), fees: -fee });
    } else if (type === "other fee" || type === "shipping label" || type === "claim" || type === "payment dispute") {
      out.push({ order: order || `fees-${(date ?? "").slice(0, 7)}`, date, kind: "fee", fees: Math.abs(money(get(r, "Net amount", "Gross transaction amount"))) });
    }
  }
  return out;
}

function etsy(rows: string[][]): Row[] | string {
  const h = headerRow(rows, ["sale date", "item name"]);
  if (h < 0) return "This doesn't look like an Etsy Order Items file (no Sale Date / Item Name columns).";
  const get = getter(rows[h]);
  return rows.slice(h + 1).map((r) => {
    const qty = money(get(r, "Quantity")) || 1;
    const price = money(get(r, "Price"));
    return {
      order: get(r, "Order ID") ?? "", date: parseDate(get(r, "Sale Date")), kind: "line" as const,
      name: get(r, "Item Name") ?? "Etsy item", sku: get(r, "SKU") ?? null, quantity: qty,
      total: money(get(r, "Item Total")) || price * qty - money(get(r, "Discount Amount")),
      shipping: money(get(r, "Order Shipping")), tax: money(get(r, "Order Sales Tax")),
    };
  });
}

function shopify(rows: string[][]): Row[] | string {
  const h = headerRow(rows, ["name", "lineitem name"]);
  if (h < 0) return "This doesn't look like a Shopify orders export (no Name / Lineitem name columns).";
  const get = getter(rows[h]);
  const STATUS: Record<string, ImportOrder["status"]> = {
    paid: "paid", partially_paid: "paid", partially_refunded: "paid", refunded: "refunded", voided: "cancelled",
    pending: "pending", authorized: "pending", expired: "cancelled",
  };
  return rows.slice(h + 1).map((r) => {
    const qty = money(get(r, "Lineitem quantity")) || 1;
    const fin = (get(r, "Financial Status") ?? "").toLowerCase();
    return {
      order: get(r, "Name") ?? "", date: parseDate(get(r, "Paid at", "Created at")), kind: "line" as const,
      status: STATUS[fin], name: get(r, "Lineitem name") ?? "Item", sku: get(r, "Lineitem sku") ?? null, quantity: qty,
      total: money(get(r, "Lineitem price")) * qty - money(get(r, "Lineitem discount")),
      shipping: money(get(r, "Shipping")), tax: money(get(r, "Taxes")), refund: money(get(r, "Refunded Amount")),
    };
  });
}

function generic(rows: string[][], map: Mapping): Row[] | string {
  if (!map.date || !map.name || !map.total) return "Pick at least the Date, Item name and Item total columns.";
  const get = getter(rows[0]);
  const STATUS: [RegExp, ImportOrder["status"]][] = [[/refund/i, "refunded"], [/cancel|void|fail/i, "cancelled"], [/pend|await|unpaid/i, "pending"]];
  return rows.slice(1).map((r, i) => {
    const st = map.status ? get(r, map.status) ?? "" : "";
    return {
      order: (map.order && get(r, map.order)) || `row-${i + 2}`, date: parseDate(get(r, map.date!)), kind: "line" as const,
      status: STATUS.find(([re]) => re.test(st))?.[1], name: get(r, map.name!) ?? "Item", sku: (map.sku && get(r, map.sku)) || null,
      quantity: (map.quantity && money(get(r, map.quantity))) || 1, total: money(get(r, map.total!)),
      shipping: map.shipping ? money(get(r, map.shipping)) : 0, tax: map.tax ? money(get(r, map.tax)) : 0,
      fees: map.fees ? Math.abs(money(get(r, map.fees))) : 0, refund: map.refund ? Math.abs(money(get(r, map.refund))) : 0,
    };
  });
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A sales file → orders with their items, grouped by order number. */
export function importSales(text: string, preset: Preset, map: Mapping = {}): ImportResult | { error: string } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: "The file is empty." };
  const parsed = preset === "ebay" ? ebay(rows) : preset === "etsy" ? etsy(rows) : preset === "shopify" ? shopify(rows) : generic(rows, map);
  if (typeof parsed === "string") return { error: parsed };

  const byOrder = new Map<string, ImportOrder & { _ship: number; _tax: number; _refund: number; _feesMax: number }>();
  let skipped = 0;
  for (const r of parsed) {
    if (!r.order || !r.date) { skipped++; continue; }
    let o = byOrder.get(r.order);
    if (!o) {
      o = { external_id: r.order, order_number: r.order, order_date: r.date, status: "paid", items_total: 0, shipping_charged: 0,
        tax_collected: 0, refunded: 0, fees: 0, total: 0, lines: [], _ship: 0, _tax: 0, _refund: 0, _feesMax: 0 };
      byOrder.set(r.order, o);
    }
    if (r.kind === "line") {
      if (r.date < o.order_date) o.order_date = r.date;
      if (r.status) o.status = r.status;
      o.lines.push({ sku: r.sku?.trim() || null, name: (r.name ?? "Item").slice(0, 300), quantity: r.quantity ?? 1, total: r2(r.total ?? 0) });
      o._ship = Math.max(o._ship, r.shipping ?? 0);
      o._tax = Math.max(o._tax, r.tax ?? 0);
      o._refund = Math.max(o._refund, r.refund ?? 0);
      // eBay charges fees per item row; others give one order-level number.
      if (preset === "ebay") o.fees += r.fees ?? 0;
      else o._feesMax = Math.max(o._feesMax, r.fees ?? 0);
    } else if (r.kind === "refund") {
      o._refund += r.refund ?? 0;
      o.fees += r.fees ?? 0; // fee credits on refunds come back as negatives
    } else {
      o.fees += r.fees ?? 0;
    }
  }

  const orders: ImportOrder[] = [];
  for (const o of byOrder.values()) {
    const { _ship, _tax, _refund, _feesMax, ...rest } = o;
    const items = r2(rest.lines.reduce((a, l) => a + l.total, 0));
    const out: ImportOrder = {
      ...rest, items_total: items, shipping_charged: r2(_ship), tax_collected: r2(_tax), refunded: r2(_refund),
      fees: r2(Math.max(0, rest.fees + _feesMax)), total: r2(items + _ship + _tax),
    };
    if (out.status === "paid" && out.refunded > 0 && out.refunded >= out.items_total + out.shipping_charged && out.lines.length) out.status = "refunded";
    orders.push(out);
  }
  const dates = orders.map((o) => o.order_date).sort();
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} without an order number or a readable date ${skipped === 1 ? "was" : "were"} skipped.`);
  if (orders.length && !orders.some((o) => o.lines.some((l) => l.sku))) warnings.push("No SKUs in this file — profit per product will match by item name only after you match SKUs.");
  return { orders, skipped, warnings, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}
