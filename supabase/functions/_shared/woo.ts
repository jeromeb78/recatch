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
  payment_method?: string;
  transaction_id?: string;
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
  payment_method: string | null;
  /** The processor's id for the payment (Stripe ch_/pi_), to match it to the processor's records. */
  payment_ref: string | null;
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

/** Stripe charge or payment-intent id: WooCommerce's transaction id, else the Stripe plugin's intent note. */
export function paymentRef(o: WooOrder): string | null {
  const tx = o.transaction_id?.trim();
  if (tx) return tx;
  const intent = (o.meta_data ?? []).find((m) => m.key === "_stripe_intent_id")?.value;
  return typeof intent === "string" && intent.trim() ? intent.trim() : null;
}

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
  // Shipping and fulfilment plugins add their own statuses ("shipped", "delivered", "awaiting-pickup"…). Those orders were
  // paid if the store recorded a payment date; anything else unknown is treated as not yet paid.
  const status = STATUS[o.status] ?? (o.date_paid ? "paid" : "pending");
  const date = (o.date_paid ?? o.date_created ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
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
      payment_method: o.payment_method?.trim() || null,
      payment_ref: paymentRef(o),
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

function ipv4Public(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast/reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // TEST-NET-2/3
  );
}

/** Expands an IPv6 address to its 8 groups, or null if it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  // Trailing dotted IPv4 (::ffff:1.2.3.4) → two hex groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    if (p.length !== 4 || p.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** True only for globally routable unicast addresses (IPv4 or IPv6). */
export function isPublicIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ipv4Public(ip);
  const g = ipv6Groups(ip);
  if (!g) return false;
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Public(embedded()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Public(embedded()); // NAT64
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1, IPv4-compatible
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 can tunnel to any IPv4
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3
}

type Resolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;
const denoResolver: Resolver = (host, type) => Deno.resolveDns(host, type);

/** Fails closed (and says why) if this runtime can't look addresses up, instead of skipping the check. */
function resolverAvailable(resolve: Resolver): boolean {
  return resolve !== denoResolver || typeof Deno.resolveDns === "function";
}

/**
 * Looks the host up and checks every address it resolves to, so a public-looking name that points at a private
 * network or the cloud metadata address is refused. Throws a user-facing message when it isn't reachable or allowed.
 */
export async function assertPublicHost(host: string, resolve: Resolver = denoResolver): Promise<void> {
  if (!isPublicHost(host)) throw new Error("That address isn't a public website");
  if (!resolverAvailable(resolve)) throw new Error("Store connections are unavailable right now (address lookup isn't supported here).");
  const settle = (type: "A" | "AAAA") => resolve(host, type).catch(() => [] as string[]);
  const ips = [...(await settle("A")), ...(await settle("AAAA"))];
  if (!ips.length) throw new Error("Couldn't find that store's address. Check it's spelled right.");
  if (!ips.every(isPublicIp)) throw new Error("That address isn't a public website");
}

export function wooAuthHeader(key: string, secret: string): string {
  return "Basic " + btoa(`${key}:${secret}`);
}

export function validKeys(key: unknown, secret: unknown): boolean {
  return typeof key === "string" && typeof secret === "string"
    && /^ck_[a-f0-9]{20,64}$/i.test(key.trim()) && /^cs_[a-f0-9]{20,64}$/i.test(secret.trim());
}

// Where cost-of-goods plugins keep a product's cost.
const COST_KEYS = ["_wc_cog_cost", "_alg_wc_cog_cost", "_wcj_purchase_price", "_purchase_price", "_cost_price"];

/** A product's cost of goods as the store records it: WooCommerce's own field, else a cost plugin's note. */
export function productCost(p: { cost_of_goods_sold?: { total_value?: unknown } | null; meta_data?: { key?: string; value?: unknown }[] }): number | null {
  const native = num(p.cost_of_goods_sold?.total_value);
  if (native > 0) return Math.round(native * 10000) / 10000;
  for (const key of COST_KEYS) {
    const v = num((p.meta_data ?? []).find((m) => m.key === key)?.value);
    if (v > 0) return Math.round(v * 10000) / 10000;
  }
  return null;
}
