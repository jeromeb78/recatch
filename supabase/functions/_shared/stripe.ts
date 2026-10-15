// Stripe charges → payments rows. Pure; network code lives in payments-sync.
// Keeps amounts, dates, status, the processing fee and the store order it belongs to — never card, billing or customer data.

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded?: number;
  currency?: string;
  created: number;
  status: string;
  captured?: boolean;
  disputed?: boolean;
  description?: string | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string>;
  balance_transaction?: string | { fee?: number; net?: number } | null;
}

export interface PaymentRow {
  external_id: string;
  payment_intent: string | null;
  paid_at: string;
  payment_date: string;
  status: "succeeded" | "pending" | "failed";
  currency: string;
  amount: number;
  refunded: number;
  fee: number;
  net: number;
  disputed: boolean;
  description: string | null;
  order_ref: string | null;
  site_url: string | null;
}

// Currencies Stripe counts in whole units (no cents).
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export function toMoney(minor: number | undefined, currency: string): number {
  const v = Number(minor) || 0;
  return ZERO_DECIMAL.has(currency) ? v : Math.round(v) / 100;
}

/** Date in the given IANA time zone (the store's books follow local days, not UTC). */
export function localDate(unix: number, timeZone = "America/New_York"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 10);
  }
}

export function mapCharge(c: StripeCharge, timeZone?: string): PaymentRow {
  const currency = (c.currency ?? "usd").toUpperCase();
  const bt = c.balance_transaction && typeof c.balance_transaction === "object" ? c.balance_transaction : null;
  const amount = toMoney(c.amount, currency);
  // An authorised but not yet captured charge hasn't moved money.
  const status: PaymentRow["status"] = c.status === "succeeded" && c.captured !== false ? "succeeded" : c.status === "failed" ? "failed" : "pending";
  const fee = bt ? toMoney(bt.fee, currency) : 0;
  const md = c.metadata ?? {};
  const orderRef = (md.order_id ?? md.woo_order_id ?? md.order_number ?? "").toString().trim();
  return {
    external_id: c.id,
    payment_intent: typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id ?? null,
    paid_at: new Date(c.created * 1000).toISOString(),
    payment_date: localDate(c.created, timeZone),
    status,
    currency,
    amount,
    refunded: toMoney(c.amount_refunded, currency),
    fee,
    net: bt ? toMoney(bt.net, currency) : status === "succeeded" ? amount - fee : 0,
    disputed: !!c.disputed,
    description: c.description ? c.description.slice(0, 200) : null,
    order_ref: orderRef || null,
    site_url: md.site_url ? String(md.site_url).slice(0, 200) : null,
  };
}

/** Restricted keys only (rk_…): a full secret key can move money, and reading is all that's needed. */
export function checkKey(key: unknown): { ok: true; live: boolean } | { ok: false; error: string } {
  const k = typeof key === "string" ? key.trim() : "";
  if (/^sk_(live|test)_/.test(k)) return { ok: false, error: "That's a full secret key. Create a restricted key with read-only access instead (see the steps)." };
  if (/^pk_/.test(k)) return { ok: false, error: "That's a publishable key. Create a restricted key (rk_…) instead." };
  const m = k.match(/^rk_(live|test)_[A-Za-z0-9]{10,}$/);
  return m ? { ok: true, live: m[1] === "live" } : { ok: false, error: "Paste a restricted key — it starts with rk_live_." };
}
