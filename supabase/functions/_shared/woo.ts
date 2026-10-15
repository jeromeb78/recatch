// WooCommerce REST (wc/v3) → Receipt Catcher sales rows. Pure helpers; network code lives in sales-sync.
// Only money, dates, SKUs and product names are kept — never customer names, emails or addresses.

export interface WooOrder {
  id: number;
  number?: string;
  status: string;
  currency?: string;
  date_created?: string | null;
  date_paid?: string | null;
  date_modified_gmt?: string | null;
  discount_total?: string;
  shipping_total?: string;
  total_tax?: string;
  total?: string;
  line_items?: { name?: string; sku?: string | null; quantity?: number; total?: string }[];
  refunds?: { total?: string }[];
  meta_data?: { key?: string; value?: unknown }[];
}

export interface SaleOrder {
  external_id: string;
  order_number: string | null;
  order_date: string;
  status: "paid" | "refunded" | "cancelled" | "pending";
  currency: string;
  items_total: number;
  discount: number;
  shipping_charged: number;
  tax_collected: number;
  refunded: number;
  fees: number;
  total: number;
}

export interface SaleLine { sku: string | null; name: string; quantity: number; total: number }

const STATUS: Record<string, SaleOrder["status"]> = {
  processing: "paid", completed: "paid", "on-hold": "paid",
  refunded: "refunded",
  cancelled: "cancelled", failed: "cancelled", trash: "cancelled",
  pending: "pending", "checkout-draft": "pending",
};

// Where payment plugins record their processing fee on the order.
const FEE_KEYS = new Set([
  "_stripe_fee", "_wcpay_transaction_fee", "_paypal_fee", "_paypal_transaction_fee", "paypal transaction fee",
  "_ppcp_paypal_fees_fee", "_square_fee", "_braintree_fee", "_mollie_fee",
]);

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;

/** Payment-processor fees recorded on the order by Stripe, WooPayments, PayPal, Square… */
export function orderFees(meta: WooOrder["meta_data"]): number {
  let fees = 0;
  for (const m of meta ?? []) {
    const k = String(m.key ?? "").toLowerCase();
    if (FEE_KEYS.has(k)) fees += Math.abs(num(typeof m.value === "object" && m.value ? (m.value as { value?: unknown }).value ?? 0 : m.value));
  }
  return cents(fees);
}

export function mapOrder(o: WooOrder): { order: SaleOrder; lines: SaleLine[] } | null {
  const status = STATUS[o.status];
  const date = (o.date_paid ?? o.date_created ?? "").slice(0, 10);
  if (!status || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const lines: SaleLine[] = (o.line_items ?? []).map((l) => ({
    sku: l.sku?.trim() || null,
    name: (l.name ?? "Item").slice(0, 300),
    quantity: Number(l.quantity) || 1,
    total: cents(num(l.total)),
  }));
  const refunded = cents((o.refunds ?? []).reduce((a, r) => a + Math.abs(num(r.total)), 0));
  return {
    order: {
      external_id: String(o.id),
      order_number: o.number ? String(o.number) : null,
      order_date: date,
      status,
      currency: (o.currency ?? "USD").toUpperCase().slice(0, 3),
      items_total: cents(lines.reduce((a, l) => a + l.total, 0)),
      discount: cents(num(o.discount_total)),
      shipping_charged: cents(num(o.shipping_total)),
      tax_collected: cents(num(o.total_tax)),
      refunded,
      fees: orderFees(o.meta_data),
      total: cents(num(o.total)),
    },
    lines,
  };
}

/** The store's base URL (https, no query), or an error message. Keeps a sub-folder install like /shop. */
export function storeBase(input: string): string | { error: string } {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return { error: "That doesn't look like a web address" };
  }
  if (u.protocol !== "https:") return { error: "The store must use https://" };
  if (!isPublicHost(u.hostname)) return { error: "That address isn't a public website" };
  const path = u.pathname.replace(/\/wp-(admin|json)\b.*$/, "").replace(/\/+$/, "");
  return `${u.origin}${path}`;
}

/** Blocks localhost, IP literals and internal names so the function can't be pointed at private networks. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return false;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(":")) return false; // IPv6
  if (/^\d+(\.\d+){3}$/.test(h)) return false; // IPv4
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|svc|cluster)$/.test(h)
    && !/(^|\.)(supabase\.co|supabase\.in)$/.test(h);
}

export function wooAuthHeader(key: string, secret: string): string {
  return "Basic " + btoa(`${key}:${secret}`);
}

export function validKeys(key: unknown, secret: unknown): boolean {
  return typeof key === "string" && typeof secret === "string"
    && /^ck_[a-f0-9]{20,64}$/i.test(key.trim()) && /^cs_[a-f0-9]{20,64}$/i.test(secret.trim());
}
