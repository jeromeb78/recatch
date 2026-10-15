import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { money, shortDate } from "../lib/format";
import { monogram } from "../lib/merchant";
import { itemKey, itemStats, KIND_LABEL, KINDS, storeStats, type ALine, type AReceipt, type ItemStat, type Kind } from "../lib/analytics";

const SWATCH: Record<Kind, string> = {
  inventory: "var(--series-1)", business: "var(--series-2)", personal: "var(--series-3)", unsorted: "var(--series-none)",
};

/** One card per store: what you spend there, how often, and on what. */
export function StoresView({ receipts, lines, onOpen }: { receipts: AReceipt[]; lines: ALine[]; onOpen: (name: string) => void }) {
  const stores = useMemo(() => storeStats(receipts, lines), [receipts, lines]);
  if (!stores.length) return <p className="muted">No receipts in this period.</p>;
  return (
    <>
      <div className="legend" aria-hidden="true">
        {KINDS.map((k) => <span key={k}><i style={{ background: SWATCH[k] }} />{KIND_LABEL[k]}</span>)}
      </div>
      <div className="store-grid">
        {stores.map((s) => {
          const m = monogram(s.name);
          const itemised = KINDS.reduce((a, k) => a + s.byKind[k], 0);
          return (
            <article key={s.key} className="card store-card">
              <header>
                <span className="monogram" style={{ background: m.bg, color: m.fg }}>{m.letter}</span>
                <div className="grow">
                  <h3>{s.name}</h3>
                  <span className="muted small">Last visit {shortDate(s.lastVisit)}</span>
                </div>
                <b className="mono">{money(s.spend)}</b>
              </header>
              <dl className="store-facts">
                <div><dt>Orders</dt><dd className="mono">{s.orders}</dd></div>
                <div><dt>Avg basket</dt><dd className="mono">{money(s.avgBasket)}</dd></div>
                <div><dt>For business</dt><dd className="mono">{itemised > 0 ? `${Math.round(s.businessShare * 100)}%` : "—"}</dd></div>
              </dl>
              {itemised > 0 && (
                <div className="share-bar" role="img"
                  aria-label={KINDS.filter((k) => s.byKind[k] > 0).map((k) => `${KIND_LABEL[k]} ${money(s.byKind[k])}`).join(", ")}>
                  {KINDS.filter((k) => s.byKind[k] > 0).map((k) => (
                    <span key={k} style={{ flexGrow: s.byKind[k], background: SWATCH[k] }} title={`${KIND_LABEL[k]}: ${money(s.byKind[k])}`} />
                  ))}
                </div>
              )}
              {s.topItems.length > 0 && (
                <ol className="top-items">
                  {s.topItems.map((t) => (
                    <li key={t.name}><span className="grow">{t.name}</span><span className="muted small">×{t.count}</span><span className="mono small">{money(t.spend)}</span></li>
                  ))}
                </ol>
              )}
              <button className="btn sm" onClick={() => onOpen(s.name)}>See {s.orders} receipt{s.orders === 1 ? "" : "s"}</button>
            </article>
          );
        })}
      </div>
    </>
  );
}

type Sort = "spend" | "purchases" | "recent" | "name";
type KindFilter = "" | Kind | "nosku";

/** Every product you've bought, merged across receipts, with unit costs and where it was cheapest. */
export function ItemsView({ lines, initialFilter = "" }: { lines: ALine[]; initialFilter?: KindFilter }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>(initialFilter);
  const [sort, setSort] = useState<Sort>("spend");
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(() => itemStats(lines), [lines]);
  const byKey = useMemo(() => {
    const m = new Map<string, ALine[]>();
    for (const l of lines) m.set(itemKey(l), [...(m.get(itemKey(l)) ?? []), l]);
    return m;
  }, [lines]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list = items.filter((i) =>
      (!term || i.name.toLowerCase().includes(term) || i.sku?.toLowerCase().includes(term) || i.stores.some((s) => s.toLowerCase().includes(term)))
      && (!kind || (kind === "nosku" ? i.kind === "inventory" && !i.sku : i.kind === kind))
    );
    const by: Record<Sort, (a: ItemStat, b: ItemStat) => number> = {
      spend: (a, b) => b.spend - a.spend,
      purchases: (a, b) => b.purchases - a.purchases || b.spend - a.spend,
      recent: (a, b) => (b.lastBought ?? "").localeCompare(a.lastBought ?? ""),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    list = [...list].sort(by[sort]);
    return list;
  }, [items, q, kind, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { "": items.length, nosku: items.filter((i) => i.kind === "inventory" && !i.sku).length };
    for (const k of KINDS) c[k] = items.filter((i) => i.kind === k).length;
    return c;
  }, [items]);

  return (
    <div className="stack-sm">
      <div className="row-wrap items-tools">
        <input type="search" className="grow" placeholder="Search items, SKUs or stores…" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline-select"><span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="spend">Most spent</option>
            <option value="purchases">Most often bought</option>
            <option value="recent">Recently bought</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <div className="chips" role="group" aria-label="Filter items">
        {([["", "All"], ["inventory", "Inventory"], ["business", "Business"], ["personal", "Personal"], ["unsorted", "Not sorted"], ["nosku", "Inventory without SKU"]] as [KindFilter, string][]).map(([k, label]) => (
          <button key={k} className={`chip-btn ${kind === k ? "on" : ""}`} onClick={() => setKind(k)} disabled={!counts[k] && kind !== k}>
            {label} · {counts[k]}
          </button>
        ))}
      </div>
      <p className="muted small">
        {shown.length} item{shown.length === 1 ? "" : "s"} · {money(shown.reduce((a, i) => a + i.spend, 0))}. Unit costs are landed: each
        receipt's tax and shipping spread across its items.
      </p>
      {shown.length === 0 ? <p className="muted">No items match.</p> : (
        <div className="card list-card scroll-x">
          <table className="data items-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Bought</th>
                <th className="num">Spent</th>
                <th className="num hide-sm">Avg / unit</th>
                <th className="num hide-sm">Lowest / unit</th>
                <th className="hide-sm">Last bought</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 300).map((i) => (
                <Fragment key={i.key}>
                  <tr className={`item-row${open === i.key ? " open" : ""}`} onClick={() => { setOpen(open === i.key ? null : i.key); setShowAll(false); }}
                    tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(open === i.key ? null : i.key), setShowAll(false))}
                    aria-expanded={open === i.key}>
                    <td>
                      <span className="item-name"><i className="dot-swatch" style={{ background: SWATCH[i.kind] }} title={KIND_LABEL[i.kind]} />{i.name}</span>
                      <span className="muted small">
                        {i.sku ? <span className="pill">{i.sku}</span> : null} {i.stores.join(", ")}
                      </span>
                    </td>
                    <td className="num">{i.purchases}× <span className="muted small">{i.units !== i.purchases ? `· ${i.units} units` : ""}</span></td>
                    <td className="num mono">{money(i.spend)}</td>
                    <td className="num mono hide-sm">{i.avgUnit != null ? money(i.avgUnit) : "—"}</td>
                    <td className="num hide-sm"><span className="mono">{i.lowUnit != null ? money(i.lowUnit) : "—"}</span>{i.stores.length > 1 && i.lowStore ? <span className="muted small"> {i.lowStore}</span> : null}</td>
                    <td className="hide-sm">{shortDate(i.lastBought)}</td>
                  </tr>
                  {open === i.key && (
                    <tr className="item-detail">
                      <td colSpan={6}>
                        <ul>
                          {[...(byKey.get(i.key) ?? [])].sort((a, b) => (b.purchase_date ?? "").localeCompare(a.purchase_date ?? "")).slice(0, showAll ? undefined : 12).map((l) => {
                            const u = Number(l.units) || Number(l.quantity) || 1;
                            return (
                              <li key={l.id}>
                                <Link to={`/receipts/${l.receipt_id}`}>{shortDate(l.purchase_date)} · {l.merchant ?? "Unknown store"}</Link>
                                <span className="muted small">{u} unit{u === 1 ? "" : "s"}</span>
                                <span className="mono small">{l.landed_total != null ? `${money(Number(l.landed_total))} · ${money(Number(l.landed_total) / u)}/unit` : "—"}</span>
                              </li>
                            );
                          })}
                        </ul>
                        {i.purchases > 12 && !showAll && (
                          <button className="link small" onClick={() => setShowAll(true)}>Show all {i.purchases} purchases</button>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {shown.length > 300 && <p className="muted small pad">Showing the top 300 — search to find others.</p>}
        </div>
      )}
    </div>
  );
}
