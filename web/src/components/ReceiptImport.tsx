import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { accountId } from "../lib/account";
import { money, shortDate } from "../lib/format";
import { useCategories } from "../lib/useCategories";
import { parseCsv } from "../lib/salesImport";
import {
  detectReceiptPreset, importReceipts, isDuplicate, RECEIPT_PRESETS, RFIELD_LABEL,
  type ImportReceipt, type ReceiptPreset, type RField, type RMapping,
} from "../lib/receiptImport";

type Existing = { merchant: string | null; purchase_date: string | null; total: number | null; order_number: string | null; source_message_id: string | null };
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const sourceId = (r: ImportReceipt) => `csv:${r.key}`.slice(0, 300);

/** Import receipts from a CSV: Amazon order history, a bank/card statement, or any spreadsheet. Works from a phone's file picker. */
export function ReceiptImport({ initial, onClose }: { initial?: { name: string; text: string }; onClose: () => void }) {
  const { categories } = useCategories();
  const [file, setFile] = useState<{ name: string; text: string } | null>(initial ?? null);
  const [preset, setPreset] = useState<ReceiptPreset>("amazon");
  const [map, setMap] = useState<RMapping>({});
  const [refunds, setRefunds] = useState(true);
  const [category, setCategory] = useState("");
  const [existing, setExisting] = useState<Existing[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; skipped: number; items: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (file) setPreset(detectReceiptPreset(parseCsv(file.text.slice(0, 20000)))); }, [file]);
  const header = useMemo(() => (file ? parseCsv(file.text.slice(0, 20000))[0] ?? [] : []), [file]);
  const result = useMemo(() => (file ? importReceipts(file.text, preset, map) : null), [file, preset, map]);
  const ok = result && !("error" in result) ? result : null;

  // What's already in Receipt Catcher around those dates, to skip purchases caught from Gmail, photos or an earlier import.
  useEffect(() => {
    setExisting(null);
    if (!ok?.from || !ok.to) return;
    let gone = false;
    (async () => {
      const out: Existing[] = [];
      for (let a = 0; ; a += 1000) {
        const { data, error } = await supabase.from("receipts").select("merchant, purchase_date, total, order_number, source_message_id")
          .eq("user_id", accountId()).gte("purchase_date", shift(ok.from!, -3)).lte("purchase_date", shift(ok.to!, 3)).range(a, a + 999);
        if (error) { if (!gone) setError(error.message); return; }
        out.push(...(data as Existing[]));
        if ((data ?? []).length < 1000) break;
      }
      if (!gone) setExisting(out);
    })();
    return () => { gone = true; };
  }, [ok]);

  const plan = useMemo(() => {
    if (!ok || !existing) return null;
    const ids = new Set(existing.map((e) => e.source_message_id).filter(Boolean));
    const wanted = ok.receipts.filter((r) => refunds || r.document_type === "receipt");
    const fresh = wanted.filter((r) => !ids.has(sourceId(r)) && !isDuplicate(r, existing));
    return { fresh, already: wanted.length - fresh.length, spent: fresh.reduce((a, r) => a + (r.document_type === "refund" ? -r.total : r.total), 0),
      items: fresh.reduce((a, r) => a + r.items.length, 0) };
  }, [ok, existing, refunds]);

  async function save() {
    if (!plan?.fresh.length || !file) return;
    setError(null);
    const owner = accountId();
    let added = 0, items = 0, skipped = 0;
    const row = (r: ImportReceipt) => ({
      user_id: owner, source: "upload", status: "ready", document_type: r.document_type, merchant: r.merchant, order_number: r.order_number,
      purchase_date: r.purchase_date, currency: "USD", subtotal: r.subtotal, tax: r.tax, shipping: r.shipping, total: r.total,
      payment_method: r.payment_method, category_id: category || null, files: [], source_message_id: sourceId(r),
      notes: `Imported from ${file.name}`, extracted: { import: { format: preset, file: file.name } },
    });
    const addItems = async (pairs: { id: string; r: ImportReceipt }[]) => {
      const lines = pairs.flatMap(({ id, r }) => r.items.map((it, position) => ({ ...it, receipt_id: id, user_id: owner, position })));
      for (let i = 0; i < lines.length; i += 500) {
        const { error } = await supabase.from("line_items").insert(lines.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
      items += lines.length;
    };
    try {
      for (let i = 0; i < plan.fresh.length; i += 100) {
        setBusy(`Saving ${Math.min(i + 100, plan.fresh.length).toLocaleString()} of ${plan.fresh.length.toLocaleString()}…`);
        const chunk = plan.fresh.slice(i, i + 100);
        const { data, error } = await supabase.from("receipts").insert(chunk.map(row)).select("id, source_message_id");
        if (!error) {
          const idOf = new Map((data ?? []).map((d) => [d.source_message_id as string, d.id as string]));
          added += idOf.size;
          await addItems(chunk.filter((r) => idOf.has(sourceId(r))).map((r) => ({ id: idOf.get(sourceId(r))!, r })));
          continue;
        }
        if (error.code !== "23505") throw new Error(error.message);
        // Something in this batch already exists (same store order number): save the rest one at a time.
        for (const r of chunk) {
          const one = await supabase.from("receipts").insert(row(r)).select("id").single();
          if (one.error) { if (one.error.code === "23505") { skipped++; continue; } throw new Error(one.error.message); }
          added++;
          await addItems([{ id: one.data.id, r }]);
        }
      }
      // Sort the new items into tax lines and business / personal, like any other receipt.
      if (items) {
        for (let round = 0; round < 25; round++) {
          setBusy("Sorting items with Claude…");
          const { data, error } = await supabase.functions.invoke("categorize-items", { body: { limit: 200, account: owner } });
          if (error || !data?.categorized || !data?.remaining) break;
        }
      }
      setDone({ added, skipped: skipped + plan.already, items });
    } catch (e) {
      setError(`${(e as Error).message}${added ? ` — ${added} receipts were saved before this; importing again skips them.` : ""}`);
    }
    setBusy(null);
  }

  if (done) {
    return (
      <section className="card stack-sm">
        <h2>Imported</h2>
        <p>{done.added.toLocaleString()} receipt{done.added === 1 ? "" : "s"} added{done.items ? ` with ${done.items.toLocaleString()} items` : ""}.
          {done.skipped ? ` ${done.skipped.toLocaleString()} were already in Receipt Catcher.` : ""}</p>
        <div className="actions tight">
          <Link className="btn primary" to="/receipts">See receipts</Link>
          <button className="link" onClick={onClose}>Done</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card stack-sm receipt-import">
      <div className="row-between"><h2>Import from a spreadsheet</h2><button className="link" onClick={onClose} disabled={!!busy}>Close</button></div>
      <label className="field">CSV file
        <input type="file" accept=".csv,text/csv,text/comma-separated-values,text/plain"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setMap({}); setDone(null); setFile({ name: f.name, text: await f.text() }); } }} />
      </label>
      {file && initial && file.name === initial.name && <p className="muted small">Shared file: {file.name}</p>}
      <label className="field">File type
        <select value={preset} onChange={(e) => setPreset(e.target.value as ReceiptPreset)}>
          {(Object.keys(RECEIPT_PRESETS) as ReceiptPreset[]).map((p) => <option key={p} value={p}>{RECEIPT_PRESETS[p].label}</option>)}
        </select>
      </label>
      <p className="muted small">{RECEIPT_PRESETS[preset].how}</p>

      {preset === "generic" && header.length > 0 && (
        <div className="mapping">
          {(Object.keys(RFIELD_LABEL) as RField[]).map((f) => (
            <label key={f} className="map-row">
              <span>{RFIELD_LABEL[f]}{["date", "store", "total"].includes(f) ? " *" : ""}</span>
              <select value={map[f] ?? ""} onChange={(e) => setMap({ ...map, [f]: e.target.value || undefined })}>
                <option value="">—</option>
                {header.map((h, i) => <option key={i} value={h}>{h}</option>)}
              </select>
            </label>
          ))}
          <p className="muted small">Pick Item name too if the file has one row per item; rows with the same order number (or store and date) become one receipt.</p>
        </div>
      )}

      {result && "error" in result && <p className="error">{result.error}</p>}
      {ok && (
        <>
          <div className="row-wrap">
            {categories.length > 0 && (
              <label className="field">Category for these receipts
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">None — sort later</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            {ok.receipts.some((r) => r.document_type === "refund") && (
              <label className="inline check"><input type="checkbox" checked={refunds} onChange={(e) => setRefunds(e.target.checked)} />Include refunds / returns</label>
            )}
          </div>
          <div className="import-preview">
            {!plan ? <span className="muted">Checking what you already have…</span> : (
              <>
                <b>{plan.fresh.length.toLocaleString()} new receipt{plan.fresh.length === 1 ? "" : "s"}{plan.items ? ` · ${plan.items.toLocaleString()} items` : ""}</b>
                <span>{ok.from && `${shortDate(ok.from)} – ${shortDate(ok.to)}`} · {money(plan.spent)}</span>
                {plan.already > 0 && <span className="muted small">{plan.already.toLocaleString()} already in Receipt Catcher (same order, or same store, amount and date) — skipped.</span>}
                {ok.warnings.map((w) => <span key={w} className="muted small">{w}</span>)}
                {preset === "statement" && <span className="muted small">Statements have no item details: each charge becomes a receipt without items. Add the store's receipt later for items and tax lines.</span>}
              </>
            )}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" onClick={save} disabled={!plan?.fresh.length || !!busy}>
          {busy ?? `Import ${plan?.fresh.length ? plan.fresh.length.toLocaleString() + " " : ""}receipts`}
        </button>
      </div>
    </section>
  );
}
