import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { accountId, useAccount } from "../lib/account";
import { money, relative } from "../lib/format";
import { download, toCsv } from "../lib/csv";
import { buildPnl, onHand, skuKey, type PBuyLine, type POrder, type PSaleLine, type PTrip, type Pnl } from "../lib/pnl";
import { refreshStale, useChannels, usePaymentAccounts, type Channel, type PaymentAccount } from "../lib/sales";
import { inScope, reconcile, type Reconciliation, type ROrder, type RPayment } from "../lib/reconcile";
import { candidatesFrom, suggest, type Candidate } from "../lib/skuMatch";
import type { TaxProfile } from "../lib/writeoffs";
import { DownloadIcon } from "./Icons";

const PAGE = 1000;
async function fetchAll<T>(make: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (((data ?? []) as T[]).length < PAGE) return out;
  }
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const short = (v: number) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : `$${Math.round(v)}`);

interface SalesData {
  /** Every order in the account (scoped after Stripe reconciliation, since a charge may match any of them). */
  orders: ROrder[];
  payments: RPayment[];
  lines: PSaleLine[];
  inventoryBuys: PBuyLine[];
  unskued: PBuyLine[];
  products: (Candidate & { stock: number | null })[];
}

/** Loads sales and the purchases that cost them for one business (or all / unassigned) up to `to`. */
function useSalesData(biz: string, to: string, enabled: boolean) {
  const [data, setData] = useState<SalesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const scope = <T,>(q: T, col = "business_id"): T => {
      const b = q as unknown as { eq(c: string, v: string): T; is(c: string, v: null): T };
      return biz === "all" ? q : biz === "none" ? b.is(col, null) : b.eq(col, biz);
    };
    try {
      const [orders, payments, lines, inventoryBuys, unskued, products] = await Promise.all([
        enabled ? fetchAll<ROrder>((a, b) => supabase.from("sales_orders")
          .select("id, order_date, status, items_total, shipping_charged, tax_collected, refunded, fees, channel_id, external_id, order_number, business_id, payment_method, payment_ref")
          .eq("user_id", accountId()).lte("order_date", to).order("order_date").range(a, b)) : [],
        enabled ? fetchAll<RPayment>((a, b) => supabase.from("payments")
          .select("id, account_id, external_id, payment_intent, payment_date, status, amount, refunded, fee, disputed, description, order_ref, site_url")
          .eq("user_id", accountId()).lte("payment_date", to).order("payment_date").range(a, b)) : [],
        enabled ? fetchAll<PSaleLine>((a, b) => scope(supabase.from("sales_lines")
          .select("order_id, sku, name, quantity, total, sales_orders!inner(business_id, order_date)")
          .eq("user_id", accountId()).lte("sales_orders.order_date", to), "sales_orders.business_id").order("id").range(a, b)) : [],
        fetchAll<PBuyLine>((a, b) => scope(supabase.from("inventory_lines")
          .select("id, description, woo_sku, units, quantity, landed_total, tax_line, use_type, business_pct, purchase_date")
          .eq("user_id", accountId()).not("woo_sku", "is", null).lte("purchase_date", to)).order("purchase_date").range(a, b)),
        fetchAll<PBuyLine>((a, b) => scope(supabase.from("inventory_lines")
          .select("id, description, woo_sku, units, quantity, landed_total, tax_line, use_type, business_pct, purchase_date")
          .eq("user_id", accountId()).is("woo_sku", null).eq("tax_line", "cogs")).order("purchase_date", { ascending: false }).range(a, b)),
        enabled ? fetchAll<Candidate & { stock: number | null }>((a, b) => supabase.from("sales_products").select("sku, name, stock")
          .eq("user_id", accountId()).order("sku").range(a, b)) : [],
      ]);
      setData({ orders, payments, lines, inventoryBuys, unskued, products });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [biz, to, enabled]);
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

export function Profit({ year, biz, periodBuys, trips, profile, saveProfile }: {
  year: string;
  biz: string;
  periodBuys: PBuyLine[];
  trips: PTrip[];
  profile: TaxProfile;
  saveProfile: (p: TaxProfile) => void;
}) {
  const { can } = useAccount();
  const canEditReports = can("reports", "edit");
  const { channels, reload: reloadChannels } = useChannels();
  const { accounts, reload: reloadAccounts } = usePaymentAccounts();
  const from = year === "all" ? "1900-01-01" : `${year}-01-01`;
  const today = new Date().toISOString().slice(0, 10);
  const to = year === "all" ? today : `${year}-12-31` < today ? `${year}-12-31` : today;
  const yearEnd = year === "all" ? today : `${year}-12-31`;
  const connected = !!channels?.length || !!accounts?.length;
  const { data, error, reload } = useSalesData(biz, to, connected);
  const [syncing, setSyncing] = useState(false);

  // Bring connected stores up to date when the tab opens (at most hourly).
  useEffect(() => {
    if (!channels || !accounts || !connected || !canEditReports) return;
    let gone = false;
    setSyncing(true);
    refreshStale(channels, accounts).then((changed) => {
      if (gone) return;
      setSyncing(false);
      if (changed) { reload(); reloadChannels(); reloadAccounts(); }
    });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels?.length, accounts?.length]);

  // Stripe decides what was charged, refunded and paid in fees; then keep this business's orders.
  const rec = useMemo<Reconciliation | null>(() => data && accounts?.length && channels
    ? reconcile({ orders: data.orders, payments: data.payments, channels, accounts }) : null, [data, accounts, channels]);
  const orders = useMemo<POrder[]>(() => (data ? inScope(rec ? rec.orders : data.orders, biz) : []), [data, rec, biz]);
  const pnl = useMemo(() => data && buildPnl({ from, to, orders, saleLines: data.lines, inventoryBuys: data.inventoryBuys, periodBuys, trips }),
    [data, orders, from, to, periodBuys, trips]);
  const stock = useMemo(() => {
    if (!data) return null;
    const m = new Map<string, number>();
    for (const p of data.products) if (p.stock != null) m.set(skuKey(p.sku), (m.get(skuKey(p.sku)) ?? 0) + Number(p.stock));
    return onHand({ asOf: to, inventoryBuys: data.inventoryBuys, orders, saleLines: data.lines, storeStock: m });
  }, [data, orders, to]);

  if (error) return <p className="error">{error}</p>;
  if (!channels || !accounts || !data || !pnl || !stock) return <p className="muted">Loading…</p>;

  const errored: (Channel | PaymentAccount)[] = [...channels, ...accounts].filter((c) => c.status === "error");
  const noSales = !connected;

  return (
    <div className="stack profit">
      {noSales && (
        <section className="card empty-profit">
          <h2>See what you really make</h2>
          <p className="muted">
            Connect your WooCommerce store or import eBay, Etsy or Shopify sales. Receipt Catcher matches what sold to what you paid
            for it and shows profit per product, fees, expenses and inventory on hand — no spreadsheets.
          </p>
          {canEditReports ? <Link className="btn primary" to="/settings#sales">Connect sales</Link> : <p className="muted small">Ask the account owner to connect sales.</p>}
        </section>
      )}

      <div className="kpi-row">
        <div className="card kpi"><span className="eyebrow"><i className="dot-swatch" style={{ background: "var(--series-1)" }} />Sales</span>
          <b className="big-number sm">{money(pnl.netSales)}</b><span className="muted small">{pnl.orders.toLocaleString()} orders · {pnl.units.toLocaleString()} units</span></div>
        <div className="card kpi"><span className="eyebrow"><i className="dot-swatch" style={{ background: "var(--series-2)" }} />Cost of goods</span>
          <b className="big-number sm">{money(pnl.cogs)}</b><span className="muted small">gross margin {pct(pnl.netSales > 0 ? pnl.grossProfit / pnl.netSales : null)}</span></div>
        <div className="card kpi"><span className="eyebrow"><i className="dot-swatch" style={{ background: "var(--series-none)" }} />Fees &amp; expenses</span>
          <b className="big-number sm">{money(pnl.fees + pnl.expenseTotal + pnl.mileage)}</b><span className="muted small">fees {money(pnl.fees)} · expenses {money(pnl.expenseTotal + pnl.mileage)}</span></div>
        <div className="card kpi"><span className="eyebrow"><i className="dot-swatch" style={{ background: "var(--series-3)" }} />Profit</span>
          <b className={`big-number sm ${pnl.profit < 0 ? "neg" : ""}`}>{money(pnl.profit)}</b><span className="muted small">margin {pct(pnl.margin)}</span></div>
      </div>

      {(pnl.unmatched.length > 0 || errored.length > 0 || data.unskued.length > 0 || syncing) && (
        <div className="gap-chips" role="list" aria-label="To tidy up">
          {syncing && <span role="listitem" className="gap-chip muted">Syncing your store…</span>}
          {errored.map((c) => <Link key={c.id} role="listitem" className="gap-chip" to="/settings#sales">{c.name}: sync failed</Link>)}
          {pnl.unmatched.length > 0 && (
            <a role="listitem" className="gap-chip" href="#match">
              {pnl.unmatched.length} sold product{pnl.unmatched.length === 1 ? "" : "s"} have no matching purchases ({money(pnl.unmatchedRevenue)} of sales with no cost)
            </a>
          )}
          {data.unskued.length > 0 && <a role="listitem" className="gap-chip" href="#match">{data.unskued.length} inventory purchases without a SKU</a>}
        </div>
      )}

      <div className="analytics-grid">
        <section className="card"><h2>Where the money went</h2><Waterfall pnl={pnl} /></section>
        <section className="card"><div className="row-between chart-head"><h2>By month</h2>
          <div className="legend" aria-hidden="true"><span><i style={{ background: "var(--series-1)" }} />Sales</span><span><i style={{ background: "var(--series-3)" }} />Profit</span></div></div>
          <MonthBars pnl={pnl} />
        </section>
      </div>

      {rec ? <StripeCheck rec={rec} from={from} to={to} biz={biz} /> : channels.some((c) => c.kind === "woocommerce") && canEditReports && (
        <p className="banner">Stripe takes your store's payments? <Link to="/settings#sales">Connect Stripe</Link> so refunds, fees and
          failed payments come from Stripe, the source of truth for money.</p>
      )}
      <Products pnl={pnl} year={year} />
      <ScheduleC pnl={pnl} year={year} biz={biz} onHandValue={stock.value} profile={profile} saveProfile={saveProfile} canEdit={canEditReports} />
      <OnHand stock={stock} asOf={yearEnd} />
      <SkuMatcher data={data} pnl={pnl} onSaved={reload} />
      <p className="muted small">
        Cost of goods uses each SKU's average landed cost (tax and shipping included) across everything you bought.
        Sales leave out sales tax you collected ({money(pnl.taxCollected)}). Fully refunded orders are treated as returned to stock.
        {channels.filter((c) => c.kind === "woocommerce" && c.last_synced_at).map((c) => ` ${c.name} synced ${relative(c.last_synced_at)}.`)}
      </p>
    </div>
  );
}

/** How store orders line up with Stripe, for the period. */
function StripeCheck({ rec, from, to, biz }: { rec: Reconciliation; from: string; to: string; biz: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const within = <T extends { date: string; business_id: string | null }>(xs: T[]) => inScope(xs, biz).filter((x) => x.date >= from && x.date <= to);
  const only = within(rec.stripeOnly);
  const missing = within(rec.missingInStripe);
  const diffs = within(rec.amountDiffs);
  const statuses = within(rec.statusDiffs);
  const matched = within(rec.matched).length;
  const items: { key: string; label: string; detail: string; rows: string[] }[] = [
    { key: "only", label: `${only.length} Stripe payment${only.length === 1 ? "" : "s"} with no store order`,
      detail: "Counted as sales from Stripe — payment links, invoices or orders from a store that isn't connected.",
      rows: only.map((x) => `${x.date} · ${money(x.amount)} · ${x.description ?? x.id}`) },
    { key: "missing", label: `${missing.length} store order${missing.length === 1 ? "" : "s"} paid by Stripe with no Stripe charge`,
      detail: "The store's numbers are used for these. Check them in Stripe — the payment may have failed or been made in another account.",
      rows: missing.map((x) => `#${x.number} · ${x.date} · ${money(x.total)}`) },
    { key: "diffs", label: `${diffs.length} order${diffs.length === 1 ? "" : "s"} where the store total differs from what Stripe charged`,
      detail: "Stripe's amount is used.", rows: diffs.map((x) => `#${x.number} · ${x.date} · store ${money(x.store)} vs Stripe ${money(x.stripe)}`) },
    { key: "status", label: `${statuses.length} order${statuses.length === 1 ? "" : "s"} where the store's status disagrees with Stripe`,
      detail: "Stripe's outcome is used (for example the store says paid but Stripe refunded it).",
      rows: statuses.map((x) => `#${x.number} · store says ${x.store}, Stripe says ${x.stripe}`) },
  ].filter((i) => i.rows.length);
  return (
    <section className="card stripe-check">
      <div className="row-between"><h2>Checked against Stripe</h2>
        <span className={`pill ${items.length ? "warn" : "ok"}`}>{items.length ? `${items.length} to look at` : "All matched"}</span></div>
      <p className="muted small">
        {matched.toLocaleString()} store orders matched to Stripe charges. Sales, refunds and fees
        come from Stripe; items and sales tax come from the store.{rec.disputed > 0 && ` ${rec.disputed} charge${rec.disputed === 1 ? " was" : "s were"} disputed — check them in Stripe.`}
      </p>
      {items.length > 0 && (
        <ul className="check-list">
          {items.map((i) => (
            <li key={i.key}>
              <button className="link" onClick={() => setOpen(open === i.key ? null : i.key)} aria-expanded={open === i.key}>{i.label}</button>
              {open === i.key && (
                <>
                  <p className="muted small">{i.detail}</p>
                  <ul className="mono small">{i.rows.slice(0, 50).map((r) => <li key={r}>{r}</li>)}</ul>
                  {i.rows.length > 50 && <p className="muted small">…and {i.rows.length - 50} more</p>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Waterfall({ pnl }: { pnl: Pnl }) {
  type Step = { label: string; delta: number; kind: "in" | "out" | "total" };
  const steps: Step[] = ([
    { label: "Sales", delta: pnl.gross, kind: "in" },
    { label: "Refunds", delta: -pnl.returns, kind: "out" },
    { label: "Cost of goods", delta: -pnl.cogs, kind: "out" },
    { label: "Fees", delta: -pnl.fees, kind: "out" },
    ...pnl.expenses.slice(0, 4).map((e) => ({ label: e.label.split(" · ")[1] ?? e.label, delta: -e.amount, kind: "out" as const })),
    ...(pnl.expenses.length > 4 ? [{ label: "Other expenses", delta: -pnl.expenses.slice(4).reduce((a, e) => a + e.amount, 0), kind: "out" as const }] : []),
    { label: "Mileage", delta: -pnl.mileage, kind: "out" },
  ] as Step[]).filter((s) => s.delta !== 0 || s.kind === "in");
  let run = 0;
  const rows = steps.map((s) => { const start = run; run += s.delta; return { ...s, start, end: run }; });
  rows.push({ label: "Profit", delta: pnl.profit, kind: "total", start: 0, end: pnl.profit });
  const lo = Math.min(0, ...rows.map((r) => Math.min(r.start, r.end)));
  const hi = Math.max(1, ...rows.map((r) => Math.max(r.start, r.end)));
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <ul className="waterfall">
      {rows.map((r) => (
        <li key={r.label} className={r.kind}>
          <span className="name">{r.label}</span>
          <span className="track">
            {lo < 0 && <i className="zero" style={{ left: `${x(0)}%` }} />}
            <span className={`bar ${r.kind === "total" && r.end < 0 ? "neg" : r.kind}`}
              style={{ left: `${x(Math.min(r.start, r.end))}%`, width: `${Math.max(0.6, Math.abs(x(r.end) - x(r.start)))}%` }} />
          </span>
          <span className="val mono">{r.kind === "out" ? `−${money(Math.abs(r.delta))}` : money(r.delta)}</span>
        </li>
      ))}
    </ul>
  );
}

function MonthBars({ pnl }: { pnl: Pnl }) {
  const [hover, setHover] = useState<number | null>(null);
  const ms = pnl.months;
  if (!ms.length) return <p className="muted small">Nothing in this period yet.</p>;
  const H = 170, top = 10, axisH = 22, left = 44;
  const hi = Math.max(1, ...ms.map((m) => Math.max(m.sales, m.profit)));
  const lo = Math.min(0, ...ms.map((m) => m.profit));
  const slot = Math.max(28, Math.min(64, 640 / ms.length));
  const W = left + slot * ms.length;
  const bw = Math.min(14, (slot - 8) / 2);
  const y = (v: number) => top + (H - top) * ((hi - v) / (hi - lo));
  const label = (m: string, yr = false) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString(undefined, yr ? { month: "short", year: "numeric" } : { month: "short" });
  const h = hover !== null ? ms[hover] : null;
  const every = Math.ceil(ms.length / 12);
  return (
    <div className="month-chart">
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${W} ${H + axisH}`} width={W} height={H + axisH} role="img" aria-label="Sales and profit by month" onMouseLeave={() => setHover(null)}>
          {[lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
            <g key={v}><line x1={left} x2={W} y1={y(v)} y2={y(v)} className={v === 0 ? "grid zero" : "grid"} />
              <text x={left - 6} y={y(v)} className="axis" textAnchor="end" dominantBaseline="middle">{short(v)}</text></g>
          ))}
          {ms.map((m, i) => {
            const x0 = left + i * slot + (slot - bw * 2 - 2) / 2;
            const bar = (v: number, x: number, fill: string) => (
              <rect x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={3} fill={fill} />
            );
            return (
              <g key={m.month} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} className={hover === i ? "on" : ""}>
                <rect x={left + i * slot} y={top} width={slot} height={H - top} className="hit" />
                {bar(m.sales, x0, "var(--series-1)")}
                {bar(m.profit, x0 + bw + 2, m.profit < 0 ? "var(--danger)" : "var(--series-3)")}
                {i % every === 0 && <text x={left + i * slot + slot / 2} y={H + 15} className="axis" textAnchor="middle">{label(m.month, m.month.endsWith("-01") || i === 0)}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-tip" aria-live="polite">
        {h ? <><b>{label(h.month, true)}</b> <span>Sales <span className="mono">{money(h.sales)}</span></span><span>Goods <span className="mono">{money(h.cogs)}</span></span>
          <span>Fees + expenses <span className="mono">{money(h.fees + h.expenses)}</span></span><span>Profit <span className="mono">{money(h.profit)}</span></span></>
          : <span className="muted">Hover or tap a month for its numbers.</span>}
      </div>
    </div>
  );
}

type PSort = "revenue" | "profit" | "margin" | "units";

function Products({ pnl, year }: { pnl: Pnl; year: string }) {
  const [sort, setSort] = useState<PSort>("revenue");
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = pnl.products.filter((p) => !term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase().includes(term));
    const by: Record<PSort, (a: typeof list[0], b: typeof list[0]) => number> = {
      revenue: (a, b) => b.revenue - a.revenue, units: (a, b) => b.units - a.units,
      profit: (a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity), margin: (a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity),
    };
    return [...list].sort(by[sort]);
  }, [pnl.products, sort, q]);
  if (!pnl.products.length) return null;
  const exportCsv = () => download(`profit-by-product-${year}.csv`, toCsv(
    rows.map((p) => ({ ...p, revenue: p.revenue.toFixed(2), cost: p.cost?.toFixed(2) ?? "", profit: p.profit?.toFixed(2) ?? "",
      margin: p.margin === null ? "" : (p.margin * 100).toFixed(1), unitCost: p.unitCost?.toFixed(4) ?? "", avgPrice: p.avgPrice.toFixed(2) })),
    ["sku", "name", "units", "revenue", "cost", "profit", "margin", "avgPrice", "unitCost"],
  ));
  return (
    <section className="card list-card">
      <div className="table-tools">
        <h2 className="grow">Profit by product</h2>
        <input type="search" aria-label="Search products" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline-select"><span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as PSort)}>
            <option value="revenue">Sales</option><option value="profit">Profit</option><option value="margin">Margin</option><option value="units">Units</option>
          </select>
        </label>
        <button className="btn sm" onClick={exportCsv}><DownloadIcon size={16} />CSV</button>
      </div>
      <div className="scroll-x">
        <table className="data">
          <thead><tr><th>Product</th><th className="num">Sold</th><th className="num">Sales</th><th className="num hide-sm">Cost</th><th className="num">Profit</th><th className="num">Margin</th></tr></thead>
          <tbody>
            {rows.slice(0, all ? undefined : 25).map((p) => (
              <tr key={p.key}>
                <td><span className="clip">{p.name}</span><span className="muted small">{p.sku ?? "no SKU"} · avg price {money(p.avgPrice)}{p.unitCost !== null ? ` · cost ${money(p.unitCost)}/unit` : ""}</span></td>
                <td className="num">{p.units.toLocaleString()}</td>
                <td className="num mono">{money(p.revenue)}</td>
                <td className="num mono hide-sm">{p.cost === null ? <a href="#match" className="warn-text">no cost</a> : money(p.cost)}</td>
                <td className={`num mono ${p.profit !== null && p.profit < 0 ? "neg" : ""}`}>{p.profit === null ? "—" : money(p.profit)}</td>
                <td className="num">{pct(p.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && !all && <p className="pad"><button className="link small" onClick={() => setAll(true)}>Show all {rows.length} products</button></p>}
    </section>
  );
}

function ScheduleC({ pnl, year, biz, onHandValue, profile, saveProfile, canEdit }: {
  pnl: Pnl; year: string; biz: string; onHandValue: number; profile: TaxProfile; saveProfile: (p: TaxProfile) => void; canEdit: boolean;
}) {
  const yi = profile.years?.[year] ?? {};
  const set = (patch: Record<string, unknown>) => saveProfile({ ...profile, years: { ...(profile.years ?? {}), [year]: { ...yi, ...patch } } });
  const usable = year !== "all" && biz !== "all";
  const endSaved = yi.inventory?.end;
  const feesSaved = Number(yi.fees?.payment ?? 0) + Number(yi.fees?.platform ?? 0);
  const rows: [string, string, number][] = [
    ["1", "Gross receipts or sales", pnl.gross],
    ["2", "Returns and allowances", pnl.returns],
    ["4", "Cost of goods sold (sold units × average cost)", pnl.cogs],
    ["10", "Commissions and fees", pnl.fees],
  ];
  return (
    <section className="card">
      <h2>For your tax return</h2>
      <p className="muted small">Schedule C lines from your sales{year !== "all" ? ` in ${year}` : ""}. Suggestions to check with your tax preparer, not tax advice.</p>
      <dl className="sched">
        {rows.map(([line, label, v]) => <div key={line}><dt><span className="pill">Line {line}</span> {label}</dt><dd className="mono">{money(v)}</dd></div>)}
        <div><dt><span className="pill">Line 41</span> Inventory on hand at year end (at cost)</dt><dd className="mono">{money(onHandValue)}</dd></div>
      </dl>
      {usable && canEdit && (
        <div className="actions">
          <button className="btn sm" disabled={endSaved === onHandValue} onClick={() => set({ inventory: { ...(yi.inventory ?? {}), end: onHandValue } })}>
            {endSaved === onHandValue ? "Ending inventory saved in Write-offs" : `Use ${money(onHandValue)} as Dec 31 inventory`}
          </button>
          {pnl.fees > 0 && (
            <button className="btn sm" disabled={Math.abs(feesSaved - pnl.fees) < 0.01} onClick={() => set({ fees: { ...(yi.fees ?? {}), payment: pnl.fees, platform: 0 } })}>
              {Math.abs(feesSaved - pnl.fees) < 0.01 ? "Fees saved in Write-offs" : `Use ${money(pnl.fees)} fees in Write-offs`}
            </button>
          )}
        </div>
      )}
      {!usable && <p className="muted small">Pick one business and a year to send these to Write-offs.</p>}
      <p className="muted small">
        On the return, line 4 comes from Part III: beginning inventory + purchases − ending inventory. Saving the inventory on hand
        above fills in the ending number so Write-offs computes it that way.
      </p>
    </section>
  );
}

function OnHand({ stock, asOf }: { stock: ReturnType<typeof onHand>; asOf: string }) {
  const [all, setAll] = useState(false);
  const rows = stock.rows.filter((r) => r.onHand > 0 || (r.storeStock ?? 0) > 0);
  if (!stock.rows.length) return null;
  return (
    <section className="card list-card">
      <div className="table-tools">
        <h2 className="grow">Inventory on hand</h2>
        <span className="muted small">{stock.units.toLocaleString()} units · <b className="mono">{money(stock.value)}</b> at cost</span>
      </div>
      <div className="scroll-x">
        <table className="data">
          <thead><tr><th>SKU</th><th className="num">Bought</th><th className="num">Sold</th><th className="num">On hand</th><th className="num hide-sm">Store says</th><th className="num">Value</th></tr></thead>
          <tbody>
            {rows.slice(0, all ? undefined : 20).map((r) => (
              <tr key={r.sku}>
                <td><span className="clip">{r.name}</span><span className="muted small mono">{r.sku} · {money(r.unit)}/unit</span></td>
                <td className="num">{r.bought.toLocaleString()}</td>
                <td className="num">{r.sold.toLocaleString()}</td>
                <td className="num">{r.onHand.toLocaleString()}</td>
                <td className={`num hide-sm ${r.storeStock !== null && r.storeStock !== r.onHand ? "warn-text" : ""}`}>{r.storeStock ?? "—"}</td>
                <td className="num mono">{money(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 20 && !all && <p className="pad"><button className="link small" onClick={() => setAll(true)}>Show all {rows.length} SKUs</button></p>}
      <p className="muted small pad">Bought − sold by SKU as of {asOf}. Where the store's own stock count differs, a count may be off or some items were bought without a receipt.</p>
    </section>
  );
}

interface Group { key: string; name: string; ids: string[]; units: number; spend: number; guess: string }

function SkuMatcher({ data, pnl, onSaved }: { data: SalesData; pnl: Pnl; onSaved: () => void }) {
  const { can } = useAccount();
  const canEdit = can("receipts", "edit");
  const candidates = useMemo(() => candidatesFrom(data.products, data.lines), [data]);
  const unmatchedSkus = useMemo(() => new Set(pnl.unmatched.map((u) => skuKey(u.sku)).filter(Boolean)), [pnl.unmatched]);
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const l of data.unskued) {
      const k = l.description.trim().toLowerCase();
      const g = m.get(k) ?? { key: k, name: l.description, ids: [], units: 0, spend: 0, guess: "" };
      g.ids.push(l.id);
      g.units += Number(l.units) || Number(l.quantity) || 1;
      g.spend += Number(l.landed_total) || 0;
      m.set(k, g);
    }
    const out = [...m.values()].map((g) => ({ ...g, guess: suggest(g.name, candidates, 1)[0]?.sku ?? "" }));
    // Purchases that would cost a product you've sold come first, then any with a guess, then by spend.
    const rank = (g: Group) => (g.guess && unmatchedSkus.has(skuKey(g.guess)) ? 0 : g.guess ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || b.spend - a.spend);
  }, [data.unskued, candidates, unmatchedSkus]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  if (!groups.length && !pnl.unmatched.length) return null;
  const value = (g: Group) => edits[g.key] ?? g.guess;
  const ready = groups.filter((g) => value(g).trim());

  async function save(list: Group[]) {
    setBusy(true);
    setMsg(null);
    for (const g of list) {
      const { error } = await supabase.from("line_items").update({ woo_sku: value(g).trim() }).in("id", g.ids);
      if (error) { setMsg(error.message); setBusy(false); return; }
    }
    setMsg(`Matched ${list.length} item${list.length === 1 ? "" : "s"}`);
    setEdits({});
    setBusy(false);
    onSaved();
  }

  return (
    <section className="card" id="match">
      <div className="row-between">
        <h2>Match purchases to products</h2>
        {canEdit && ready.length > 1 && <button className="btn sm primary" disabled={busy} onClick={() => save(ready)}>Save {ready.length} matches</button>}
      </div>
      <p className="muted small">
        Give inventory you bought the SKU it sells under, so its cost counts against those sales. Suggestions come from your store's
        products and what's sold; check them before saving.
      </p>
      {pnl.unmatched.length > 0 && (
        <p className="small">
          <b>Sold with no purchases yet:</b> {pnl.unmatched.slice(0, 8).map((u) => u.sku ? `${u.sku} (${u.name})` : u.name).join(", ")}
          {pnl.unmatched.length > 8 && ` and ${pnl.unmatched.length - 8} more`}. Match a purchase below, or add the receipt you bought them on.
        </p>
      )}
      <datalist id="sku-options">{candidates.map((c) => <option key={c.sku} value={c.sku}>{c.name}</option>)}</datalist>
      {groups.length === 0 ? <p className="muted small">Every inventory purchase has a SKU.</p> : (
        <ul className="match-list">
          {groups.slice(0, all ? undefined : 30).map((g) => (
            <li key={g.key}>
              <span className="grow"><span className="clip">{g.name}</span><span className="muted small">{g.ids.length}× · {g.units} units · {money(g.spend)}</span></span>
              <input list="sku-options" aria-label={`SKU for ${g.name}`} placeholder="SKU" value={value(g)} disabled={!canEdit}
                onChange={(e) => setEdits({ ...edits, [g.key]: e.target.value })} />
              {canEdit && <button className="btn sm" disabled={busy || !value(g).trim()} onClick={() => save([g])}>Save</button>}
            </li>
          ))}
        </ul>
      )}
      {groups.length > 30 && !all && <button className="link small" onClick={() => setAll(true)}>Show all {groups.length}</button>}
      {msg && <p className="muted small">{msg}</p>}
    </section>
  );
}
