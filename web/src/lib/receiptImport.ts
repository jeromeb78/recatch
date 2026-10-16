// A spreadsheet of purchases → receipts with their items. Parsing happens in the browser; nothing is sent until the
// user confirms. Presets for Amazon order history and bank / card statements, and a pick-the-columns option.
// Pure, for tests.

import { money, parseCsv, parseDate } from "./salesImport";

export type ReceiptPreset = "amazon" | "statement" | "generic";

export const RECEIPT_PRESETS: Record<ReceiptPreset, { label: string; how: string }> = {
  amazon: {
    label: "Amazon order history",
    how: "Amazon → Account → Request your data → Your Orders. In the download, open Retail.OrderHistory.1.csv. One row per item.",
  },
  statement: {
    label: "Bank or credit card statement",
    how: "Download transactions as CSV from your bank or card website (or app → Statements → Export). One row per charge, no items.",
  },
  generic: { label: "Other (pick the columns)", how: "Any CSV with one row per purchase, or one row per item with an order number." },
};

export type RField = "date" | "store" | "total" | "order" | "item" | "quantity" | "price" | "tax";
export const RFIELD_LABEL: Record<RField, string> = {
  date: "Date", store: "Store / description", total: "Amount (receipt or item total)", order: "Order number",
  item: "Item name", quantity: "Quantity", price: "Item price", tax: "Tax",
};
export type RMapping = Partial<Record<RField, string>>;

export interface ImportItem { description: string; quantity: number; unit_price: number | null; total: number; store_sku: string | null }
export interface ImportReceipt {
  /** Stable id for this purchase, so importing the same file again is recognised. */
  key: string;
  merchant: string;
  order_number: string | null;
  purchase_date: string;
  document_type: "receipt" | "refund";
  subtotal: number | null;
  tax: number | null;
  shipping: number | null;
  total: number;
  payment_method: string | null;
  items: ImportItem[];
}
export interface ReceiptImportResult { receipts: ImportReceipt[]; skipped: number; warnings: string[]; from: string | null; to: string | null }

const r2 = (v: number) => Math.round(v * 100) / 100;
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function headerAt(rows: string[][], anyOf: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const hs = rows[i].map(norm);
    if (anyOf.some((need) => need.every((n) => hs.includes(n)))) return i;
  }
  return -1;
}
function getter(header: string[]) {
  const idx = new Map(header.map((h, i) => [norm(h), i] as const));
  return (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = idx.get(norm(n));
      const v = i === undefined ? undefined : row[i]?.trim();
      if (v && v !== "--" && v.toLowerCase() !== "not available") return v;
    }
    return undefined;
  };
}

export function detectReceiptPreset(rows: string[][]): ReceiptPreset {
  if (headerAt(rows, [["order id", "order date", "product name"], ["order id", "order date", "title"]]) >= 0) return "amazon";
  if (headerAt(rows, [["date", "description", "amount"], ["transaction date", "description"], ["posting date", "description"], ["date", "payee"], ["date", "merchant", "amount"]]) >= 0) return "statement";
  return "generic";
}

/* ---------------- bank / card statements ---------------- */

// Lines on a statement that aren't purchases.
const NOT_A_PURCHASE = /\b(payment|thank you|autopay|auto pay|transfer|xfer|deposit|interest|fee reversal|cash ?back|reward|direct dep|payroll|zelle|venmo cashout|ach credit|balance)\b/i;

/** "SQ *BLUE BOTTLE #123 OAKLAND CA" → "Blue Bottle". Statement descriptions are noisy; this keeps the store name. */
export function cleanMerchant(raw: string): string {
  let s = raw.replace(/^(sq|tst|sp|py|pp|paypal|ppl|dd|in|bt|wpy|fs|ckc)\s*\*\s*/i, "")
    .replace(/\b(pos|debit|purchase|card|recurring|visa|mc|ach|online|web)\b\s*/gi, " ")
    .replace(/\s*[#*]\s*[A-Za-z0-9]*\d[A-Za-z0-9]*.*$/, "") // "#123 …", "*AB12CD"
    .replace(/\s+\d{3,}.*$/, "")
    .replace(/\s+(?:[A-Z][a-z]+\s+)?[A-Z]{2}(\s+\d{5})?$/, "") // trailing "City ST 12345"
    .replace(/\s{2,}/g, " ").trim();
  if (!s) s = raw.trim();
  return s.length > 3 && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])[a-z]/g, (c) => c.toUpperCase()) : s;
}

function statement(rows: string[][]): ReceiptImportResult | string {
  const h = headerAt(rows, [["date"], ["transaction date"], ["posting date"], ["posted date"]]);
  if (h < 0) return "Couldn't find a Date column in this statement.";
  const get = getter(rows[h]);
  const body = rows.slice(h + 1);
  type T = { date: string | null; desc: string; amount: number };
  const tx: T[] = body.map((r) => {
    const debit = money(get(r, "Debit", "Withdrawal", "Withdrawals", "Charge", "Charges"));
    const credit = money(get(r, "Credit", "Deposit", "Deposits", "Payment"));
    const amount = get(r, "Amount", "Transaction Amount") !== undefined ? money(get(r, "Amount", "Transaction Amount")) : credit - Math.abs(debit);
    return { date: parseDate(get(r, "Transaction Date", "Trans. Date", "Date", "Posting Date", "Posted Date")), desc: get(r, "Description", "Payee", "Merchant", "Name", "Memo") ?? "", amount };
  });
  // Card exports list charges as positive, bank exports as negative: whichever sign most purchases have is "spent".
  const nonPay = tx.filter((t) => t.amount !== 0 && !NOT_A_PURCHASE.test(t.desc));
  const spentSign = nonPay.filter((t) => t.amount < 0).length >= nonPay.filter((t) => t.amount > 0).length ? -1 : 1;
  const out: ImportReceipt[] = [];
  let skipped = 0;
  const seen = new Map<string, number>();
  for (const t of tx) {
    if (!t.date || !t.desc || !t.amount || NOT_A_PURCHASE.test(t.desc)) { skipped++; continue; }
    const spent = Math.sign(t.amount) === spentSign;
    const merchant = cleanMerchant(t.desc);
    const total = r2(Math.abs(t.amount));
    const base = `stmt|${t.date}|${merchant.toLowerCase()}|${total}|${spent ? "c" : "r"}`;
    const n = (seen.get(base) ?? 0) + 1; // two identical charges on the same day stay two receipts
    seen.set(base, n);
    out.push({
      key: `${base}|${n}`, merchant, order_number: null, purchase_date: t.date, document_type: spent ? "receipt" : "refund",
      subtotal: null, tax: null, shipping: null, total, payment_method: null, items: [],
    });
  }
  return finish(out, skipped);
}

/* ---------------- Amazon ---------------- */

function amazon(rows: string[][]): ReceiptImportResult | string {
  const h = headerAt(rows, [["order id", "order date"]]);
  if (h < 0) return "This doesn't look like Amazon order history (no Order ID / Order Date columns).";
  const get = getter(rows[h]);
  const orders = new Map<string, ImportReceipt>();
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const id = get(r, "Order ID");
    const date = parseDate(get(r, "Order Date"));
    const status = (get(r, "Order Status") ?? "").toLowerCase();
    if (!id || !date || status.includes("cancel")) { skipped++; continue; }
    const qty = money(get(r, "Quantity")) || 1;
    const unit = money(get(r, "Unit Price", "Purchase Price Per Unit"));
    const tax = money(get(r, "Unit Price Tax", "Item Subtotal Tax", "Shipment Item Subtotal Tax"));
    const ship = money(get(r, "Shipping Charge"));
    const owed = money(get(r, "Total Owed", "Item Total"));
    const lineTotal = r2(unit ? unit * qty : owed - tax);
    let o = orders.get(id);
    if (!o) {
      o = { key: `amazon|${id}`, merchant: "Amazon", order_number: id, purchase_date: date, document_type: "receipt", subtotal: 0, tax: 0,
        shipping: 0, total: 0, payment_method: get(r, "Payment Instrument Type") ?? null, items: [] };
      orders.set(id, o);
    }
    o.items.push({ description: (get(r, "Product Name", "Title") ?? "Amazon item").slice(0, 300), quantity: qty, unit_price: unit || null, total: lineTotal,
      store_sku: get(r, "ASIN", "ASIN/ISBN") ?? null });
    o.subtotal = r2((o.subtotal ?? 0) + lineTotal);
    o.tax = r2((o.tax ?? 0) + tax);
    o.shipping = r2((o.shipping ?? 0) + ship);
    o.total = r2(o.total + (owed || lineTotal + tax + ship));
  }
  return finish([...orders.values()], skipped);
}

/* ---------------- any CSV ---------------- */

function generic(rows: string[][], map: RMapping): ReceiptImportResult | string {
  if (!map.date || !map.store || !map.total) return "Pick at least the Date, Store and Amount columns.";
  const get = getter(rows[0]);
  const byItem = !!map.item;
  const groups = new Map<string, ImportReceipt>();
  let skipped = 0, row = 0;
  for (const r of rows.slice(1)) {
    row++;
    const date = parseDate(get(r, map.date));
    const store = get(r, map.store);
    const amount = money(get(r, map.total));
    if (!date || !store || !amount) { skipped++; continue; }
    const order = map.order ? get(r, map.order) ?? null : null;
    // One row per item: rows sharing an order number (or store + date when there isn't one) form one receipt.
    const gk = byItem ? `${store.toLowerCase()}|${order ?? date}` : `row${row}`;
    let g = groups.get(gk);
    if (!g) {
      g = { key: `csv|${store.toLowerCase()}|${date}|${order ?? (byItem ? "" : `${r2(Math.abs(amount))}|${row}`)}`, merchant: store.slice(0, 120),
        order_number: order, purchase_date: date, document_type: amount < 0 && !byItem ? "refund" : "receipt", subtotal: null,
        tax: null, shipping: null, total: 0, payment_method: null, items: [] };
      groups.set(gk, g);
    }
    const tax = map.tax ? money(get(r, map.tax)) : 0;
    if (byItem) {
      const qty = (map.quantity && money(get(r, map.quantity))) || 1;
      const price = map.price ? money(get(r, map.price)) : 0;
      g.items.push({ description: (get(r, map.item!) ?? "Item").slice(0, 300), quantity: qty, unit_price: price || null, total: r2(Math.abs(amount)), store_sku: null });
      g.subtotal = r2((g.subtotal ?? 0) + Math.abs(amount));
      if (tax) g.tax = r2((g.tax ?? 0) + tax);
      g.total = r2(g.total + Math.abs(amount) + tax);
    } else {
      g.total = r2(Math.abs(amount));
      if (tax) g.tax = r2(tax);
    }
  }
  return finish([...groups.values()], skipped);
}

function finish(receipts: ImportReceipt[], skipped: number): ReceiptImportResult {
  const dates = receipts.map((r) => r.purchase_date).sort();
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (payments, transfers, cancelled orders, or no date/amount).`);
  return { receipts, skipped, warnings, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

export function importReceipts(text: string, preset: ReceiptPreset, map: RMapping = {}): ReceiptImportResult | { error: string } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: "The file is empty." };
  const r = preset === "amazon" ? amazon(rows) : preset === "statement" ? statement(rows) : generic(rows, map);
  return typeof r === "string" ? { error: r } : r;
}

/** Same purchase already in Receipt Catcher (e.g. caught from Gmail): same store, same total, within 3 days. */
export function isDuplicate(r: ImportReceipt, existing: { merchant: string | null; purchase_date: string | null; total: number | string | null; order_number: string | null }[]): boolean {
  const key = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const m = key(r.merchant);
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  return existing.some((e) => {
    if (r.order_number && e.order_number && e.order_number === r.order_number) return true;
    const em = key(e.merchant);
    if (!em || !m || !(em.startsWith(m) || m.startsWith(em))) return false;
    return Math.abs(Number(e.total ?? 0) - r.total) < 0.01 && !!e.purchase_date && Math.abs(day(e.purchase_date) - day(r.purchase_date)) <= 3;
  });
}
