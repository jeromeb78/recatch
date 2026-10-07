import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { date, money, signedTotal } from "../lib/format";
import { download, toCsv } from "../lib/csv";
import type { Receipt } from "../lib/types";

const PAGE = 1000;
const COLUMNS =
  "id, source, status, review_reasons, document_type, merchant, order_number, purchase_date, currency, subtotal, tax, shipping, discount, total, payment_method, category_id, notes, confidence, email_subject, email_from, files, created_at";

type Filters = { q: string; status: string; category: string; source: string; from: string; to: string };

function useFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const [params, setParams] = useSearchParams();
  const filters: Filters = {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "",
    category: params.get("category") ?? "",
    source: params.get("source") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
  const update = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    setParams(p, { replace: true });
  };
  return [filters, update];
}

async function fetchReceipts(f: Filters): Promise<Receipt[]> {
  const all: Receipt[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("receipts")
      .select(COLUMNS)
      .order("purchase_date", { ascending: false, nullsFirst: true })
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (f.status) q = q.eq("status", f.status);
    if (f.source) q = q.eq("source", f.source);
    if (f.category === "none") q = q.is("category_id", null);
    else if (f.category) q = q.eq("category_id", f.category);
    if (f.from) q = q.gte("purchase_date", f.from);
    if (f.to) q = q.lte("purchase_date", f.to);
    const term = f.q.replace(/[,()*%\\]/g, " ").trim();
    if (term) {
      const like = `*${term}*`;
      q = q.or(
        `merchant.ilike.${like},order_number.ilike.${like},items_text.ilike.${like},email_subject.ilike.${like},notes.ilike.${like}`,
      );
    }
    const { data, error } = await q;
    if (error) throw error;
    all.push(...((data ?? []) as Receipt[]));
    if (!data || data.length < PAGE) return all;
  }
}

export default function Receipts() {
  const [filters, setFilters] = useFilters();
  const [search, setSearch] = useState(filters.q);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const { categories } = useCategories();
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const key = JSON.stringify(filters);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchReceipts(filters)
      .then((r) => !cancelled && setReceipts(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && setFilters({ q: search }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const totals = useMemo(() => {
    const t = { all: 0, business: 0, personal: 0, review: 0 };
    for (const r of receipts ?? []) {
      const v = signedTotal(r);
      t.all += v;
      if (r.category_id && catById.get(r.category_id)?.is_business) t.business += v;
      else t.personal += v;
      if (r.status === "needs_review") t.review++;
    }
    return t;
  }, [receipts, catById]);

  function exportReceipts() {
    if (!receipts) return;
    const rows = receipts.map((r) => ({
      ...r,
      category: r.category_id ? catById.get(r.category_id)?.name : "",
      is_business: r.category_id ? !!catById.get(r.category_id)?.is_business : false,
    }));
    download(
      `receipts-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(rows, [
        "purchase_date", "merchant", "order_number", "document_type", "category", "is_business",
        "subtotal", "tax", "shipping", "discount", "total", "currency", "payment_method",
        "status", "review_reasons", "source", "notes", "id",
      ]),
    );
  }

  async function exportLineItems() {
    if (!receipts?.length) return;
    setExporting(true);
    try {
      const ids = receipts.map((r) => r.id);
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase
          .from("line_items_export")
          .select("*")
          .in("receipt_id", ids.slice(i, i + 200))
          .order("purchase_date", { ascending: false })
          .order("position");
        if (error) throw error;
        rows.push(...(data ?? []));
      }
      download(
        `line-items-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(rows, [
          "purchase_date", "merchant", "order_number", "description", "store_sku", "woo_sku",
          "quantity", "unit_price", "total", "category", "is_business", "currency", "status",
          "receipt_id", "line_item_id",
        ]),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="stats">
        <div className="stat"><span>Total</span><strong>{money(totals.all)}</strong></div>
        <div className="stat"><span>Business</span><strong>{money(totals.business)}</strong></div>
        <div className="stat"><span>Personal / other</span><strong>{money(totals.personal)}</strong></div>
        <button className="stat clickable" onClick={() => setFilters({ status: filters.status ? "" : "needs_review" })}>
          <span>Needs review</span><strong className={totals.review ? "warn" : ""}>{totals.review}</strong>
        </button>
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search merchant, order #, items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
          <option value="">Any status</option>
          <option value="ready">Ready</option>
          <option value="needs_review">Needs review</option>
        </select>
        <select value={filters.category} onChange={(e) => setFilters({ category: e.target.value })}>
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filters.source} onChange={(e) => setFilters({ source: e.target.value })}>
          <option value="">All sources</option>
          <option value="gmail">Gmail</option>
          <option value="forward">Forwarded</option>
          <option value="upload">Upload</option>
        </select>
        <input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} title="From" />
        <input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} title="To" />
        <div className="spacer" />
        <button onClick={exportReceipts} disabled={!receipts?.length}>Receipts CSV</button>
        <button onClick={exportLineItems} disabled={!receipts?.length || exporting}>
          {exporting ? "Exporting…" : "Line items CSV"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {receipts === null ? (
        <p className="muted">Loading…</p>
      ) : receipts.length === 0 ? (
        <div className="card empty">
          <p>No receipts yet.</p>
          <p className="muted">
            Connect Gmail or copy your forwarding address in <Link to="/settings">Settings</Link>, or{" "}
            <Link to="/add">snap a photo</Link>.
          </p>
        </div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th className="hide-sm">Order #</th>
              <th className="hide-sm">Category</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => {
              const cat = r.category_id ? catById.get(r.category_id) : undefined;
              return (
                <tr key={r.id}>
                  <td className="nowrap">{date(r.purchase_date)}</td>
                  <td>
                    <Link to={`/receipts/${r.id}`}>{r.merchant ?? "Unknown merchant"}</Link>
                    {r.document_type === "refund" && <span className="pill">refund</span>}
                    <span className="source">{r.source}</span>
                  </td>
                  <td className="hide-sm mono">{r.order_number ?? ""}</td>
                  <td className="hide-sm">
                    {cat && <span className="cat" style={{ borderColor: cat.color ?? undefined }}>{cat.name}</span>}
                  </td>
                  <td className="num">{money(signedTotal(r), r.currency)}</td>
                  <td>
                    {r.status === "needs_review" && (
                      <span className="pill warn" title={r.review_reasons.join("\n")}>Needs review</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
