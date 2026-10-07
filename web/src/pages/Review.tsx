import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BUCKET, supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { date, money } from "../lib/format";
import { SOURCE_LABEL } from "../lib/merchant";
import { TAX_LINES, taxShort } from "../lib/tax";
import { AlertIcon, CheckIcon, CloseIcon, FileIcon } from "../components/Icons";
import type { LineItem, Receipt } from "../lib/types";

interface Suggestion {
  sku: string;
  from: string;
}

/** Looks up the Woo SKU used last time for the same store SKU or the same item description. */
async function suggestSku(item: LineItem): Promise<Suggestion | null> {
  const base = () =>
    supabase.from("line_items").select("woo_sku, created_at").not("woo_sku", "is", null)
      .neq("receipt_id", item.receipt_id).order("created_at", { ascending: false }).limit(1);
  if (item.store_sku) {
    const { data } = await base().eq("store_sku", item.store_sku);
    if (data?.[0]?.woo_sku) return { sku: data[0].woo_sku, from: data[0].created_at };
  }
  const desc = item.description.replace(/[%_\\]/g, (c) => `\\${c}`);
  const { data } = await base().ilike("description", desc);
  return data?.[0]?.woo_sku ? { sku: data[0].woo_sku, from: data[0].created_at } : null;
}

export default function Review() {
  const navigate = useNavigate();
  const { categories } = useCategories();
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const [queue, setQueue] = useState<Receipt[] | null>(null);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<LineItem[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [thumb, setThumb] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [skuDraft, setSkuDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("receipts").select("*").eq("status", "needs_review")
      .order("purchase_date", { ascending: false, nullsFirst: true })
      .then(({ data, error }) => {
        if (error) return setError(error.message);
        setQueue((data ?? []) as Receipt[]);
        setTotal(data?.length ?? 0);
      });
  }, []);

  const current = queue?.[0];

  const loadCurrent = useCallback(async (r: Receipt) => {
    setItems([]);
    setSuggestions({});
    setThumb(null);
    setEditing(null);
    const { data } = await supabase.from("line_items").select("*").eq("receipt_id", r.id).order("position");
    const li = (data ?? []) as LineItem[];
    setItems(li);
    const image = (r.files ?? []).find((f) => f.mime.startsWith("image/"));
    if (image) {
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(image.path, 3600);
      setThumb(signed?.signedUrl ?? null);
    }
    const found = await Promise.all(li.filter((i) => !i.woo_sku).map(async (i) => [i.id, await suggestSku(i)] as const));
    setSuggestions(Object.fromEntries(found.filter(([, s]) => s)) as Record<string, Suggestion>);
  }, []);

  useEffect(() => {
    if (current) loadCurrent(current);
  }, [current, loadCurrent]);

  async function saveSku(item: LineItem, sku: string) {
    const value = sku.trim() || null;
    const { error } = await supabase.from("line_items").update({ woo_sku: value }).eq("id", item.id);
    if (error) return setError(error.message);
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, woo_sku: value } : i)));
    setEditing(null);
  }

  async function approve() {
    if (!current) return;
    setBusy(true);
    const { error } = await supabase.from("receipts").update({ status: "ready", review_reasons: [] }).eq("id", current.id);
    setBusy(false);
    if (error) return setError(error.message);
    setQueue((q) => (q ?? []).slice(1));
  }

  const skip = () => setQueue((q) => (q && q.length > 1 ? [...q.slice(1), q[0]] : q));

  if (error && !queue) return <p className="error">{error}</p>;
  if (!queue) return <p className="muted">Loading…</p>;

  if (!current) {
    return (
      <div className="stack">
        <div className="card caught-up">
          <span className="done-icon"><CheckIcon size={28} /></span>
          <h1>All caught up</h1>
          <p className="muted">Nothing needs a look right now.</p>
          <Link to="/" className="btn primary">Back to Home</Link>
        </div>
      </div>
    );
  }

  const position = total - queue.length + 1;
  const category = current.category_id ? catById.get(current.category_id) : undefined;

  return (
    <div className="review">
      <div className="review-head">
        <Link to="/" className="icon-btn" aria-label="Close review"><CloseIcon /></Link>
        <div className="grow">
          <span className="strong">Review · {Math.min(position, total)} of {total}</span>
          <div className="progress" aria-hidden="true">
            {Array.from({ length: Math.min(total, 12) }, (_, i) => (
              <span key={i} className={i < Math.min(position, 12) ? "on" : ""} />
            ))}
          </div>
        </div>
        {queue.length > 1 && <button className="link" onClick={skip}>Skip</button>}
      </div>

      <section className="card summary">
        <div className="thumb">
          {thumb ? <img src={thumb} alt="Receipt photo" /> : <FileIcon />}
        </div>
        <div className="summary-text">
          <span className="merchant">{current.merchant ?? "Unknown merchant"}</span>
          <span className="muted small">{date(current.purchase_date)} · from {SOURCE_LABEL[current.source]}</span>
          {current.order_number && <span className="muted small mono">#{current.order_number}</span>}
          <span className="big-number sm">{money(current.total, current.currency)}</span>
        </div>
      </section>

      {current.review_reasons.length > 0 && (
        <div className="callout">
          <AlertIcon />
          <ul>{current.review_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {items.length > 0 && (
        <section className="card list-card">
          {items.map((it) => {
            const s = suggestions[it.id];
            return (
              <div key={it.id} className="item">
                <div className="item-line">
                  <span>{it.quantity !== 1 && `${it.quantity} × `}{it.description}</span>
                  <span className="amount">{money(it.total, current.currency)}</span>
                </div>
                <div className="item-meta">
                  {editing === it.id ? (
                    <form
                      className="sku-form"
                      onSubmit={(e: FormEvent) => { e.preventDefault(); saveSku(it, skuDraft); }}
                    >
                      <input aria-label={`Woo SKU for ${it.description}`} autoFocus value={skuDraft}
                        onChange={(e) => setSkuDraft(e.target.value)} placeholder="Woo SKU" />
                      <button className="btn sm primary">Save</button>
                      <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : it.woo_sku ? (
                    <button className="chip sku" onClick={() => { setEditing(it.id); setSkuDraft(it.woo_sku ?? ""); }}>
                      SKU {it.woo_sku}
                    </button>
                  ) : s ? (
                    <>
                      <button className="chip sku" onClick={() => saveSku(it, s.sku)}>Use SKU {s.sku}</button>
                      <span className="muted small">matched from {date(s.from)}</span>
                    </>
                  ) : (
                    <button className="chip add" onClick={() => { setEditing(it.id); setSkuDraft(""); }}>+ Map to SKU</button>
                  )}
                  {it.tax_line ? (
                    <span className={`chip tax ${it.tax_confidence != null && it.tax_confidence < 0.6 ? "unsure" : ""}`}
                      title={TAX_LINES[it.tax_line] ?? it.tax_line}>
                      {taxShort(it.tax_line)}{it.use_type === "mixed" ? " · mixed" : ""}
                    </span>
                  ) : it.category_id && catById.get(it.category_id) ? (
                    <span className="chip cat">{catById.get(it.category_id)!.name}</span>
                  ) : null}
                  {it.pack_size > 1 && it.total != null && (
                    <span className="muted small">{it.quantity * it.pack_size} units · {money(Number(it.total) / (it.quantity * it.pack_size), current.currency)}/unit</span>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="totals-row">
        <span>Subtotal <b>{money(current.subtotal, current.currency)}</b></span>
        <span>Tax <b>{money(current.tax, current.currency)}</b></span>
        <span>Category <b>{category?.name ?? "None"}</b></span>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="review-actions">
        <button className="btn lg" onClick={() => navigate(`/receipts/${current.id}`)}>Edit</button>
        <button className="btn lg primary grow2" onClick={approve} disabled={busy}>
          <CheckIcon size={18} />{queue.length > 1 ? "Looks right · Next" : "Looks right"}
        </button>
      </div>
    </div>
  );
}
