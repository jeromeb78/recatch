import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { money, signedTotal } from "../lib/format";
import { DownloadIcon, SearchIcon } from "../components/Icons";
import ReceiptRow from "../components/ReceiptRow";
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
    <div className="stack">
      <div className="page-head row-between">
        <h1>All receipts</h1>
        <div className="head-actions">
          <button className="btn sm" onClick={exportReceipts} disabled={!receipts?.length}>
            <DownloadIcon size={16} />Receipts CSV
          </button>
          <button className="btn sm" onClick={exportLineItems} disabled={!receipts?.length || exporting}>
            <DownloadIcon size={16} />{exporting ? "Exporting…" : "Line items CSV"}
          </button>
        </div>
      </div>

      <div className="search">
        <SearchIcon />
        <input
          type="search"
          aria-label="Search receipts"
          placeholder="Search store, order #, items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="chips" role="group" aria-label="Quick filters">
        <button className={`chip-btn ${!filters.status ? "on" : ""}`} onClick={() => setFilters({ status: "" })}>All</button>
        <button className={`chip-btn ${filters.status === "needs_review" ? "on" : ""}`}
          onClick={() => setFilters({ status: filters.status === "needs_review" ? "" : "needs_review" })}>
          Needs review{totals.review > 0 && !filters.status ? ` · ${totals.review}` : ""}
        </button>
        {(["gmail", "forward", "upload"] as const).map((s) => (
          <button key={s} className={`chip-btn ${filters.source === s ? "on" : ""}`}
            onClick={() => setFilters({ source: filters.source === s ? "" : s })}>
            {s === "gmail" ? "Gmail" : s === "forward" ? "Forwarded" : "Photo"}
          </button>
        ))}
      </div>

      <details className="more-filters" open={!!(filters.category || filters.from || filters.to)}>
        <summary>Category &amp; dates</summary>
        <div className="filters">
          <label>Category
            <select value={filters.category} onChange={(e) => setFilters({ category: e.target.value })}>
              <option value="">All categories</option>
              <option value="none">Uncategorized</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>From<input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} /></label>
          <label>To<input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} /></label>
        </div>
      </details>

      {receipts && receipts.length > 0 && (
        <div className="summary-line">
          <span>{receipts.length} receipt{receipts.length === 1 ? "" : "s"}</span>
          <span>Total <b>{money(totals.all)}</b></span>
          <span>Business <b>{money(totals.business)}</b></span>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {receipts === null ? (
        <p className="muted">Loading…</p>
      ) : receipts.length === 0 ? (
        <div className="card empty">
          <p><b>No receipts match.</b></p>
          <p className="muted">
            Connect Gmail or copy your forwarding address in <Link to="/settings">Settings</Link>, or{" "}
            <Link to="/add">snap a photo</Link>.
          </p>
        </div>
      ) : (
        <div className="card list-card">
          {receipts.map((r) => (
            <ReceiptRow key={r.id} r={r} category={r.category_id ? catById.get(r.category_id) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
