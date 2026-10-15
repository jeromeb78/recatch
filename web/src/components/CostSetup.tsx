import { FormEvent, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { accountId, useAccount } from "../lib/account";
import { money } from "../lib/format";
import { download, toCsv } from "../lib/csv";
import { parseSkuCosts, suggestPools, type CostPool, type PoolStat, type SkuCost } from "../lib/costs";
import type { Pnl } from "../lib/pnl";

const SOURCE_LABEL = { manual: "your cost", store: "store cost", receipts: "tagged receipts", pool: "product line" } as const;
const phrases = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);

/** Cost of goods setup: product lines (pools) for "styles may vary" buying, plus your own per-SKU costs that override them. */
export function CostSetup({ pools, stats, pnl, skuCosts, purchaseNames, productNames, business, onSaved }: {
  pools: CostPool[];
  stats: Map<string, PoolStat>;
  pnl: Pnl;
  skuCosts: SkuCost[];
  purchaseNames: string[];
  productNames: string[];
  business: string | null;
  onSaved: () => void;
}) {
  const canEdit = useAccount().can("reports", "edit");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ordered = useMemo(() => [...pools].sort((a, b) => a.position - b.position), [pools]);

  const bySource = useMemo(() => {
    const c = { manual: 0, store: 0, receipts: 0, pool: 0, none: 0 };
    for (const p of pnl.products) c[p.costSource ?? "none"] += p.units;
    return c;
  }, [pnl.products]);
  const soldByPool = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pnl.products) if (p.costSource === "pool" && p.costLabel) m.set(p.costLabel, (m.get(p.costLabel) ?? 0) + p.units);
    return m;
  }, [pnl.products]);
  const totalUnits = Object.values(bySource).reduce((a, b) => a + b, 0);

  async function run(label: string, f: () => PromiseLike<{ error: { message: string } | null }>) {
    setMsg(null);
    const { error } = await f();
    if (error) setMsg(error.message);
    else { setMsg(label); onSaved(); }
  }
  const nextPos = () => (ordered.length ? Math.max(...ordered.map((p) => p.position)) + 10 : 0);
  const move = (p: CostPool, dir: -1 | 1) => {
    const i = ordered.indexOf(p), j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    const other = ordered[j];
    run("Order saved", async () => {
      const a = await supabase.from("cost_pools").update({ position: other.position }).eq("id", p.id);
      if (a.error) return a;
      return supabase.from("cost_pools").update({ position: p.position === other.position ? p.position + dir : p.position }).eq("id", other.id);
    });
  };

  return (
    <section className="card cost-setup" id="costs">
      <h2>Cost of goods setup</h2>
      <p className="muted small">
        Each product sold is costed from the most specific source: <b>your cost</b> for that SKU → the <b>store's cost</b> (if WooCommerce
        keeps one) → <b>receipts tagged</b> with the SKU → its <b>product line</b>'s average cost from your receipts. Add a SKU's cost
        whenever you know it and it replaces the product-line average from then on.
      </p>
      {totalUnits > 0 && (
        <div className="source-bar" role="img" aria-label={`Units sold costed by source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")}`}>
          {(["manual", "store", "receipts", "pool", "none"] as const).filter((k) => bySource[k] > 0).map((k) => (
            <span key={k} className={`src ${k}`} style={{ flexGrow: bySource[k] }} title={`${k === "none" ? "no cost" : SOURCE_LABEL[k]}: ${bySource[k]} units`} />
          ))}
        </div>
      )}
      <div className="legend source-legend">
        {(["manual", "store", "receipts", "pool", "none"] as const).map((k) => (
          <span key={k}><i className={`src ${k}`} />{k === "none" ? "No cost yet" : SOURCE_LABEL[k][0].toUpperCase() + SOURCE_LABEL[k].slice(1)} <b>{bySource[k].toLocaleString()}</b></span>
        ))}
      </div>

      <h3>Product lines</h3>
      {ordered.length === 0 && !suggesting && (
        <p className="muted small">No product lines yet. Suggest them from what you buy and sell, or add one.</p>
      )}
      {ordered.length > 0 && (
        <div className="scroll-x">
          <table className="data pools">
            <thead><tr><th>Line</th><th className="num">Bought</th><th className="num">Avg cost</th><th className="num">Unit cost</th><th className="num hide-sm">Sold</th><th /></tr></thead>
            <tbody>
              {ordered.map((p, i) => {
                const s = stats.get(p.id);
                return editing === p.id ? (
                  <tr key={p.id}><td colSpan={6}><PoolForm pool={p} business={business} position={p.position} onDone={() => { setEditing(null); onSaved(); }} /></td></tr>
                ) : (
                  <tr key={p.id}>
                    <td><b>{p.name}</b><span className="muted small">buys: {p.purchase_words.join(", ") || "—"} · sells: {p.product_words.join(", ") || "—"}</span></td>
                    <td className="num">{s?.units.toLocaleString() ?? 0}<span className="muted small">{s?.purchases ?? 0} receipts · {money(s?.spend ?? 0)}</span></td>
                    <td className="num mono">{s?.avg != null ? money(s.avg) : "—"}</td>
                    <td className="num"><UnitCostInput pool={p} avg={s?.avg ?? null} canEdit={canEdit} onSaved={onSaved} /></td>
                    <td className="num hide-sm">{(soldByPool.get(p.name) ?? 0).toLocaleString()}</td>
                    <td className="nowrap">
                      {canEdit && <>
                        <button className="link small" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(p, -1)}>↑</button>{" "}
                        <button className="link small" aria-label={`Move ${p.name} down`} disabled={i === ordered.length - 1} onClick={() => move(p, 1)}>↓</button>{" "}
                        <button className="link small" onClick={() => setEditing(p.id)}>Edit</button>{" "}
                        <button className="link small danger" onClick={() => confirm(`Remove “${p.name}”? Products in it go back to having no cost (unless another line matches).`)
                          && run("Removed", () => supabase.from("cost_pools").delete().eq("id", p.id))}>Remove</button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {ordered.length > 0 && (
        <p className="muted small">The first line that matches wins, so keep specific lines (Car Culture) above general ones (Hot Wheels).
          Unit cost is the line's average landed cost per car from your receipts unless you type your own.</p>
      )}
      {canEdit && editing === "new" && <PoolForm business={business} position={nextPos()} onDone={() => { setEditing(null); onSaved(); }} />}
      {canEdit && suggesting && (
        <Suggestions purchaseNames={purchaseNames} productNames={productNames} existing={ordered} business={business} start={nextPos()}
          onDone={() => { setSuggesting(false); onSaved(); }} />
      )}
      {canEdit && editing === null && !suggesting && (
        <div className="actions">
          <button className="btn sm" onClick={() => setSuggesting(true)}>Suggest product lines</button>
          <button className="btn sm" onClick={() => setEditing("new")}>Add a product line</button>
        </div>
      )}

      <h3>Your SKU costs</h3>
      <SkuCostImport skuCosts={skuCosts} canEdit={canEdit} onSaved={onSaved} />
      {msg && <p className="muted small">{msg}</p>}
    </section>
  );
}

function UnitCostInput({ pool, avg, canEdit, onSaved }: { pool: CostPool; avg: number | null; canEdit: boolean; onSaved: () => void }) {
  const [v, setV] = useState(pool.unit_cost == null ? "" : String(Number(pool.unit_cost)));
  async function save() {
    const next = v.trim() === "" ? null : Number(v.replace(/[$,]/g, ""));
    if (next !== null && (!Number.isFinite(next) || next < 0)) return setV(pool.unit_cost == null ? "" : String(pool.unit_cost));
    if (next === (pool.unit_cost == null ? null : Number(pool.unit_cost))) return;
    const { error } = await supabase.from("cost_pools").update({ unit_cost: next }).eq("id", pool.id);
    if (!error) onSaved();
  }
  return (
    <input className="cost-input" inputMode="decimal" aria-label={`Unit cost for ${pool.name}`} disabled={!canEdit} value={v}
      placeholder={avg != null ? avg.toFixed(2) : "set"} onChange={(e) => setV(e.target.value)} onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
  );
}

function PoolForm({ pool, business, position, onDone }: { pool?: CostPool; business: string | null; position: number; onDone: () => void }) {
  const [name, setName] = useState(pool?.name ?? "");
  const [buy, setBuy] = useState(pool?.purchase_words.join(", ") ?? "");
  const [sell, setSell] = useState(pool?.product_words.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const row = { name: name.trim(), purchase_words: phrases(buy), product_words: phrases(sell) };
    const { error } = pool
      ? await supabase.from("cost_pools").update(row).eq("id", pool.id)
      : await supabase.from("cost_pools").insert({ ...row, user_id: accountId(), business_id: business, position });
    if (error) setError(error.message);
    else onDone();
  }
  return (
    <form className="stack-sm pool-form" onSubmit={submit}>
      <label className="field">Name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot Wheels Car Culture" /></label>
      <div className="row-wrap">
        <label className="field">Receipt words <span className="muted">(comma-separated phrases)</span>
          <input value={buy} onChange={(e) => setBuy(e.target.value)} placeholder="car culture" /></label>
        <label className="field">Store product words
          <input value={sell} onChange={(e) => setSell(e.target.value)} placeholder="car culture" /></label>
      </div>
      <p className="muted small">A name matches when it contains every word of any one phrase, in any order (“hot wheels” also matches “HotWheels”).</p>
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" disabled={!name.trim()}>{pool ? "Save" : "Add"}</button>
        <button type="button" className="link" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function Suggestions({ purchaseNames, productNames, existing, business, start, onDone }: {
  purchaseNames: string[]; productNames: string[]; existing: CostPool[]; business: string | null; start: number; onDone: () => void;
}) {
  const list = useMemo(() => suggestPools(purchaseNames, productNames).filter((s) => !existing.some((p) => p.name === s.name)),
    [purchaseNames, productNames, existing]);
  const [picked, setPicked] = useState(() => new Set(list.map((s) => s.name)));
  const [error, setError] = useState<string | null>(null);
  async function create() {
    const rows = list.filter((s) => picked.has(s.name)).map((s, i) => ({
      user_id: accountId(), business_id: business, name: s.name, purchase_words: s.words, product_words: s.words, position: start + i * 10,
    }));
    if (!rows.length) return onDone();
    const { error } = await supabase.from("cost_pools").insert(rows);
    if (error) setError(error.message);
    else onDone();
  }
  if (!list.length) {
    return <div className="stack-sm"><p className="muted small">No common product lines found in both your receipts and your store. Add one by hand.</p>
      <div className="actions tight"><button className="link" onClick={onDone}>Close</button></div></div>;
  }
  return (
    <div className="stack-sm suggestions">
      <p className="small">Found in both your receipts and your store (most specific first):</p>
      <ul>
        {list.map((s) => (
          <li key={s.name}>
            <label className="inline check">
              <input type="checkbox" checked={picked.has(s.name)} onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(s.name); else next.delete(s.name);
                setPicked(next);
              }} />
              <b>{s.name}</b> <span className="muted small">{s.purchases} kinds of receipt item · {s.products} products</span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" onClick={create} disabled={!picked.size}>Add {picked.size} product line{picked.size === 1 ? "" : "s"}</button>
        <button className="link" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function SkuCostImport({ skuCosts, canEdit, onSaved }: { skuCosts: SkuCost[]; canEdit: boolean; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseSkuCosts(text) : null), [text]);
  const withCost = skuCosts.filter((s) => s.unit_cost != null);

  async function save() {
    if (!parsed?.rows.length) return;
    setBusy(true);
    setMsg(null);
    const now = new Date().toISOString();
    for (let i = 0; i < parsed.rows.length; i += 500) {
      const { error } = await supabase.from("sku_costs").upsert(
        parsed.rows.slice(i, i + 500).map((r) => ({ ...r, user_id: accountId(), updated_at: now })), { onConflict: "user_id,sku" });
      if (error) { setMsg(error.message); setBusy(false); return; }
    }
    setMsg(`Saved ${parsed.rows.length.toLocaleString()} SKU cost${parsed.rows.length === 1 ? "" : "s"}`);
    setText("");
    setBusy(false);
    onSaved();
  }

  return (
    <div className="stack-sm">
      <p className="muted small">
        {withCost.length ? `${withCost.length.toLocaleString()} SKU${withCost.length === 1 ? " has" : "s have"} your own cost. ` : ""}
        Set one in the product table below, or upload a CSV of <span className="mono">sku,cost</span> — uploading again updates the costs.
        {withCost.length > 0 && <> <button className="link small" onClick={() => download("sku-costs.csv", toCsv(withCost.map((s) => ({ sku: s.sku, cost: s.unit_cost })), ["sku", "cost"]))}>Download yours</button></>}
      </p>
      {canEdit && (
        <>
          <div className="row-wrap">
            <label className="field">CSV file<input type="file" accept=".csv,text/csv,text/plain" onChange={async (e) => setText(await e.target.files?.[0]?.text() ?? "")} /></label>
          </div>
          <label className="field">…or paste<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={"HCJ85,6.50\nGJP91,4.25"} /></label>
          {parsed && <p className="small">{parsed.rows.length.toLocaleString()} SKU cost{parsed.rows.length === 1 ? "" : "s"} ready{parsed.skipped ? ` · ${parsed.skipped} line${parsed.skipped === 1 ? "" : "s"} skipped (no SKU or cost)` : ""}</p>}
          <div className="actions tight"><button className="primary" disabled={busy || !parsed?.rows.length} onClick={save}>{busy ? "Saving…" : "Save SKU costs"}</button></div>
        </>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
