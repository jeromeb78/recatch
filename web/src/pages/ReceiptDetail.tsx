import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BUCKET, supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { money } from "../lib/format";
import type { LineItem, Receipt } from "../lib/types";

type Draft = Omit<LineItem, "id" | "receipt_id"> & { id?: string };

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export default function ReceiptDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { categories } = useCategories();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [items, setItems] = useState<Draft[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { data: r, error } = await supabase.from("receipts").select("*").eq("id", id).single();
      if (error) return setMessage({ kind: "error", text: error.message });
      setReceipt(r as Receipt);
      const { data: li } = await supabase.from("line_items").select("*").eq("receipt_id", id).order("position");
      setItems((li ?? []) as LineItem[]);
      const paths = ((r as Receipt).files ?? []).map((f) => f.path);
      if (paths.length) {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
        setFileUrls(Object.fromEntries((signed ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path as string, s.signedUrl as string])));
      }
    })();
  }, [id]);

  if (!receipt) {
    return message ? <p className="error">{message.text}</p> : <p className="muted">Loading…</p>;
  }

  const set = <K extends keyof Receipt>(k: K, v: Receipt[K]) => setReceipt({ ...receipt, [k]: v });
  const setItem = (i: number, patch: Partial<Draft>) =>
    setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const itemsSum = items.reduce((a, it) => a + Number(it.total ?? 0), 0);

  async function save(markReviewed = false) {
    if (!receipt) return;
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("receipts")
        .update({
          merchant: receipt.merchant,
          order_number: receipt.order_number,
          purchase_date: receipt.purchase_date || null,
          document_type: receipt.document_type,
          subtotal: receipt.subtotal,
          tax: receipt.tax,
          shipping: receipt.shipping,
          discount: receipt.discount,
          total: receipt.total,
          currency: receipt.currency,
          payment_method: receipt.payment_method,
          category_id: receipt.category_id,
          notes: receipt.notes,
          ...(markReviewed ? { status: "ready", review_reasons: [] } : {}),
        })
        .eq("id", receipt.id);
      if (error) throw error;

      if (removed.length) {
        const { error } = await supabase.from("line_items").delete().in("id", removed);
        if (error) throw error;
      }
      const { data: { user } } = await supabase.auth.getUser();
      const rows = items.map((it, position) => ({
        ...(it.id ? { id: it.id } : {}),
        receipt_id: receipt.id,
        user_id: user!.id,
        position,
        description: it.description || "(item)",
        store_sku: it.store_sku || null,
        quantity: it.quantity ?? 1,
        unit_price: it.unit_price,
        total: it.total,
        category_id: it.category_id,
        woo_sku: it.woo_sku || null,
      }));
      const existing = rows.filter((r) => "id" in r);
      const fresh = rows.filter((r) => !("id" in r));
      if (existing.length) {
        const { error } = await supabase.from("line_items").upsert(existing);
        if (error) throw error;
      }
      if (fresh.length) {
        const { error } = await supabase.from("line_items").insert(fresh);
        if (error) throw error;
      }
      const { data: li } = await supabase.from("line_items").select("*").eq("receipt_id", receipt.id).order("position");
      setItems((li ?? []) as LineItem[]);
      setRemoved([]);
      if (markReviewed) setReceipt({ ...receipt, status: "ready", review_reasons: [] });
      setMessage({ kind: "ok", text: "Saved" });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!receipt || !confirm("Delete this receipt and its stored files?")) return;
    const paths = (receipt.files ?? []).map((f) => f.path);
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    const { error } = await supabase.from("receipts").delete().eq("id", receipt.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    navigate("/");
  }

  return (
    <div className="detail">
      <p><Link to="/">← All receipts</Link></p>

      {receipt.status === "needs_review" && (
        <div className="banner warn">
          <strong>Needs review</strong>
          <ul>{receipt.review_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <div className="grid2">
        <section className="card">
          <h2>Receipt</h2>
          <div className="form">
            <label>Merchant<input value={receipt.merchant ?? ""} onChange={(e) => set("merchant", e.target.value || null)} /></label>
            <label>Order #<input value={receipt.order_number ?? ""} onChange={(e) => set("order_number", e.target.value || null)} /></label>
            <label>Date<input type="date" value={receipt.purchase_date ?? ""} onChange={(e) => set("purchase_date", e.target.value || null)} /></label>
            <label>
              Type
              <select value={receipt.document_type} onChange={(e) => set("document_type", e.target.value)}>
                <option value="receipt">Receipt</option>
                <option value="order_confirmation">Order confirmation</option>
                <option value="invoice">Invoice</option>
                <option value="refund">Refund</option>
              </select>
            </label>
            <label>
              Category
              <select value={receipt.category_id ?? ""} onChange={(e) => set("category_id", e.target.value || null)}>
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_business ? " (business)" : ""}</option>)}
              </select>
            </label>
            <label>Payment<input value={receipt.payment_method ?? ""} onChange={(e) => set("payment_method", e.target.value || null)} /></label>
            {(["subtotal", "discount", "shipping", "tax", "total"] as const).map((k) => (
              <label key={k} className="cap">
                {k}
                <input type="number" step="0.01" value={receipt[k] ?? ""} onChange={(e) => set(k, num(e.target.value))} />
              </label>
            ))}
            <label>Currency<input value={receipt.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></label>
            <label className="full">Notes<textarea rows={2} value={receipt.notes ?? ""} onChange={(e) => set("notes", e.target.value || null)} /></label>
          </div>
          <p className="muted small">
            Source: {receipt.source}
            {receipt.email_from && <> · from {receipt.email_from}</>}
            {receipt.email_subject && <> · “{receipt.email_subject}”</>}
            {receipt.confidence != null && <> · confidence {Math.round(Number(receipt.confidence) * 100)}%</>}
          </p>
        </section>

        <section className="card">
          <h2>Original</h2>
          {(receipt.files ?? []).length === 0 && <p className="muted">No stored file.</p>}
          {(receipt.files ?? []).map((f) => {
            const url = fileUrls[f.path];
            return (
              <div key={f.path} className="file">
                {url && f.mime.startsWith("image/") && <img src={url} alt={f.name} />}
                {url && f.mime === "text/html" && (
                  <iframe title={f.name} src={url} sandbox="" />
                )}
                {url ? <a href={url} target="_blank" rel="noreferrer">Open {f.name}</a> : <span>{f.name}</span>}
              </div>
            );
          })}
        </section>
      </div>

      <section className="card">
        <h2>Line items</h2>
        <div className="scroll-x">
          <table className="items">
            <thead>
              <tr>
                <th>Description</th>
                <th>Store SKU</th>
                <th className="num">Qty</th>
                <th className="num">Unit</th>
                <th className="num">Total</th>
                <th>Category</th>
                <th>Woo SKU</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.id ?? `new-${i}`}>
                  <td><input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} /></td>
                  <td><input className="mono" value={it.store_sku ?? ""} onChange={(e) => setItem(i, { store_sku: e.target.value })} /></td>
                  <td><input className="num" type="number" step="any" value={it.quantity ?? ""} onChange={(e) => setItem(i, { quantity: num(e.target.value) ?? 1 })} /></td>
                  <td><input className="num" type="number" step="0.01" value={it.unit_price ?? ""} onChange={(e) => setItem(i, { unit_price: num(e.target.value) })} /></td>
                  <td><input className="num" type="number" step="0.01" value={it.total ?? ""} onChange={(e) => setItem(i, { total: num(e.target.value) })} /></td>
                  <td>
                    <select value={it.category_id ?? ""} onChange={(e) => setItem(i, { category_id: e.target.value || null })}>
                      <option value="">(receipt’s)</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td><input className="mono" placeholder="—" value={it.woo_sku ?? ""} onChange={(e) => setItem(i, { woo_sku: e.target.value })} /></td>
                  <td>
                    <button
                      className="link danger"
                      title="Remove"
                      onClick={() => {
                        if (it.id) setRemoved([...removed, it.id]);
                        setItems(items.filter((_, j) => j !== i));
                      }}
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  <button
                    className="link"
                    onClick={() =>
                      setItems([...items, {
                        position: items.length, description: "", store_sku: null, quantity: 1,
                        unit_price: null, total: null, category_id: null, woo_sku: null,
                      }])}
                  >+ Add line</button>
                </td>
                <td className="num"><strong>{money(itemsSum, receipt.currency)}</strong></td>
                <td colSpan={3} className="muted small">
                  {receipt.subtotal != null && Math.abs(itemsSum - Number(receipt.subtotal)) > 0.05 &&
                    `Subtotal is ${money(receipt.subtotal, receipt.currency)}`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="actions">
        <button className="primary" disabled={saving} onClick={() => save(false)}>{saving ? "Saving…" : "Save"}</button>
        {receipt.status === "needs_review" && (
          <button disabled={saving} onClick={() => save(true)}>Save &amp; mark reviewed</button>
        )}
        <div className="spacer" />
        <button className="danger" onClick={remove}>Delete</button>
      </div>
      {message && <p className={message.kind === "ok" ? "ok" : "error"}>{message.text}</p>}
    </div>
  );
}
