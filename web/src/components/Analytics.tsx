import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { money } from "../lib/format";
import { byMonth, change, KIND_LABEL, kpis, storeStats, type ALine, type AReceipt, type Kind, type Period } from "../lib/analytics";
import { categoryStats, type CategoryInfo, type CategoryStat } from "../lib/categoryStats";
import { taxShort } from "../lib/tax";

// Fixed categorical order (validated: dataviz palette slots 1–3) + neutral gray for "not sorted yet".
const CHART_KINDS: Kind[] = ["inventory", "business", "personal", "unsorted"];
const SWATCH: Record<Kind, string> = {
  inventory: "var(--series-1)", business: "var(--series-2)", personal: "var(--series-3)", unsorted: "var(--series-none)",
};

const short = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${Math.round(n)}`);
const monthLabel = (m: string, withYear = false) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, withYear ? { month: "short", year: "numeric" } : { month: "short" });
};

function Delta({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined) return null;
  const c = change(now, before);
  if (c === null) return <span className="muted small">no earlier data</span>;
  return <span className="muted small">{c > 0 ? "▲" : c < 0 ? "▼" : "·"} {Math.abs(c)}% vs previous</span>;
}

function Legend() {
  return (
    <div className="legend" aria-hidden="true">
      {CHART_KINDS.map((k) => <span key={k}><i style={{ background: SWATCH[k] }} />{KIND_LABEL[k]}</span>)}
    </div>
  );
}

/** Spend per month, stacked by kind. Hover or tap a month for its numbers. */
function MonthChart({ receipts, lines }: { receipts: AReceipt[]; lines: ALine[] }) {
  const months = useMemo(() => byMonth(receipts, lines), [receipts, lines]);
  const [hover, setHover] = useState<number | null>(null);
  if (!months.length) return <p className="muted small">No receipts in this period.</p>;

  const H = 170, top = 10, axisH = 22, left = 44;
  const max = Math.max(1, ...months.map((m) => CHART_KINDS.reduce((a, k) => a + Math.max(0, m.byKind[k]), 0)));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / p / (max / p > 5 ? 2 : 1)) * p * (max / p > 5 ? 2 : 1);
  })();
  const slot = Math.max(18, Math.min(56, 640 / months.length));
  const W = left + slot * months.length;
  const barW = Math.min(24, slot - 6);
  const y = (v: number) => top + (H - top) * (1 - v / nice);
  const showLabelEvery = Math.ceil(months.length / 12);
  const h = hover !== null ? months[hover] : null;

  return (
    <div className="month-chart">
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${W} ${H + axisH}`} width={W} height={H + axisH} role="img"
          aria-label={`Spend by month, ${monthLabel(months[0].month, true)} to ${monthLabel(months[months.length - 1].month, true)}`}
          onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={left} x2={W} y1={y(nice * t)} y2={y(nice * t)} className="grid" />
              <text x={left - 6} y={y(nice * t)} className="axis" textAnchor="end" dominantBaseline="middle">{short(nice * t)}</text>
            </g>
          ))}
          {months.map((m, i) => {
            const x = left + i * slot + (slot - barW) / 2;
            let acc = 0;
            const segs = CHART_KINDS.filter((k) => m.byKind[k] > 0).map((k) => {
              const y0 = y(acc), y1 = y(acc + m.byKind[k]);
              acc += m.byKind[k];
              return { k, y: y1, h: Math.max(0, y0 - y1 - 2) }; // 2px surface gap between segments
            });
            const last = segs.length - 1;
            return (
              <g key={m.month} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} className={hover === i ? "on" : ""}>
                <rect x={left + i * slot} y={top} width={slot} height={H - top} className="hit" />
                {segs.map((s, j) => (
                  j === last
                    ? <path key={s.k} fill={SWATCH[s.k]} d={`M${x},${s.y + s.h} V${s.y + 4} Q${x},${s.y} ${x + 4},${s.y} H${x + barW - 4} Q${x + barW},${s.y} ${x + barW},${s.y + 4} V${s.y + s.h} Z`} />
                    : <rect key={s.k} x={x} y={s.y} width={barW} height={s.h} fill={SWATCH[s.k]} />
                ))}
                {i % showLabelEvery === 0 && (
                  <text x={left + i * slot + slot / 2} y={H + 15} className="axis" textAnchor="middle">
                    {monthLabel(m.month, m.month.endsWith("-01") || i === 0)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-tip" aria-live="polite">
        {h ? (
          <>
            <b>{monthLabel(h.month, true)}</b> <span className="mono">{money(h.total)}</span>
            {CHART_KINDS.filter((k) => h.byKind[k] > 0).map((k) => (
              <span key={k}><i style={{ background: SWATCH[k] }} />{KIND_LABEL[k]} <span className="mono">{money(h.byKind[k])}</span></span>
            ))}
          </>
        ) : <span className="muted">Hover or tap a month for its numbers.</span>}
      </div>
    </div>
  );
}

/** Where the money went, by store — tap one to see its receipts. */
function StoreBars({ receipts, lines, onStore }: { receipts: AReceipt[]; lines: ALine[]; onStore: (name: string) => void }) {
  const stores = useMemo(() => storeStats(receipts, lines), [receipts, lines]);
  if (!stores.length) return null;
  const shown = stores.slice(0, 6);
  const other = stores.slice(6).reduce((a, s) => a + s.spend, 0);
  const max = Math.max(...shown.map((s) => s.spend), other, 1);
  return (
    <ul className="store-bars">
      {shown.map((s) => (
        <li key={s.key}>
          <button className="store-bar" onClick={() => onStore(s.name)} title={`See ${s.name} receipts`}>
            <span className="name">{s.name}</span>
            <span className="track"><span className="fill" style={{ width: `${Math.max(2, (s.spend / max) * 100)}%` }} /></span>
            <span className="val mono">{money(s.spend)}</span>
            <span className="muted small">{s.orders} order{s.orders === 1 ? "" : "s"}</span>
          </button>
        </li>
      ))}
      {other > 0 && (
        <li>
          <div className="store-bar">
            <span className="name muted">{stores.length - 6} other stores</span>
            <span className="track"><span className="fill other" style={{ width: `${Math.max(2, (other / max) * 100)}%` }} /></span>
            <span className="val mono">{money(other)}</span>
            <span />
          </div>
        </li>
      )}
    </ul>
  );
}

export interface Gaps { review: number; unassigned: number | null; noSku: number }

/** One card per receipt category: spend, receipts, and the likely write-offs in it. Tap to list its receipts. */
function CategoryCards({ stats, active, onCategory }: { stats: CategoryStat[]; active: string; onCategory: (id: string) => void }) {
  if (!stats.length) return null;
  return (
    <div className="card">
      <div className="row-between chart-head">
        <h2>By category</h2>
        <span className="muted small">Write-offs use your items' tax lines · not tax advice</span>
      </div>
      <div className="category-grid">
        {stats.map((c) => {
          const on = active === c.id;
          const delta = c.prevSpend != null ? change(c.spend, c.prevSpend) : null;
          return (
            <button key={c.id} className={`category-card${on ? " on" : ""}`} onClick={() => onCategory(on ? "" : c.id)} aria-pressed={on}
              title={on ? "Show all receipts" : `Show ${c.name} receipts`}>
              <span className="cat-head">
                <i className="dot-swatch" style={{ background: c.color || (c.isBusiness ? "var(--series-1)" : "var(--series-none)") }} />
                <b className="grow">{c.name}</b>
              </span>
              {c.id !== "none" && <span className={`pill cat-kind ${c.isBusiness ? "ok" : ""}`}>{c.isBusiness ? "Business" : "Personal"}</span>}
              <span className="cat-spend">
                <b className="mono">{money(c.spend)}</b>
                <span className="muted small">{c.receipts} receipt{c.receipts === 1 ? "" : "s"}{delta !== null ? ` · ${delta > 0 ? "▲" : delta < 0 ? "▼" : "·"} ${Math.abs(delta)}%` : ""}</span>
              </span>
              {c.writeOffTotal > 0 ? (
                <span className="cat-writeoffs">
                  <span className="small"><b>Write-offs <span className="mono">{money(c.writeOffTotal)}</span></b></span>
                  {c.writeOffs.slice(0, 3).map((w) => (
                    <span key={w.line} className="small muted wo-line">
                      <span className="grow">{w.line === "cogs" ? "Cost of goods (as it sells)" : taxShort(w.line)}</span>
                      <span className="mono">{money(w.amount)}</span>
                    </span>
                  ))}
                  {c.writeOffs.length > 3 && <span className="small muted">+{c.writeOffs.length - 3} more lines</span>}
                </span>
              ) : c.personalNote ? (
                <span className="small muted cat-note">{c.personalNote.label}</span>
              ) : (
                <span className="small muted cat-note">{c.isBusiness ? "No items sorted to a tax line yet" : "Not deductible"}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Analytics({ period, cur, prev, gaps, onStore, onNoSku, onUnassigned, categories = [], activeCategory = "", onCategory }: {
  period: Period;
  cur: { receipts: AReceipt[]; lines: ALine[] };
  prev: { receipts: AReceipt[]; lines: ALine[] } | null;
  gaps: Gaps;
  onStore: (name: string) => void;
  onNoSku: () => void;
  onUnassigned: () => void;
  categories?: CategoryInfo[];
  activeCategory?: string;
  onCategory?: (id: string) => void;
}) {
  const cats = useMemo(() => categoryStats({ receipts: cur.receipts, lines: cur.lines, categories, prevReceipts: prev?.receipts ?? null }),
    [cur, prev, categories]);
  const k = useMemo(() => kpis(cur.receipts, cur.lines), [cur]);
  const p = useMemo(() => (prev ? kpis(prev.receipts, prev.lines) : undefined), [prev]);
  const tiles: { label: string; value: string; now: number; before?: number; swatch?: Kind; note?: string }[] = [
    { label: "Spent", value: money(k.spend), now: k.spend, before: p?.spend, note: `${k.receipts} receipts · ${k.stores} store${k.stores === 1 ? "" : "s"}` },
    { label: "Inventory", value: money(k.byKind.inventory), now: k.byKind.inventory, before: p?.byKind.inventory, swatch: "inventory" },
    { label: "Business expenses", value: money(k.byKind.business), now: k.byKind.business, before: p?.byKind.business, swatch: "business" },
    { label: "Personal", value: money(k.byKind.personal), now: k.byKind.personal, before: p?.byKind.personal, swatch: "personal" },
    { label: "Average order", value: money(k.avgOrder), now: k.avgOrder, before: p?.avgOrder },
  ];

  return (
    <section className="analytics" aria-label={`Overview, ${period.label}`}>
      <div className="kpi-row">
        {tiles.map((t) => (
          <div key={t.label} className="card kpi">
            <span className="eyebrow">{t.swatch && <i className="dot-swatch" style={{ background: SWATCH[t.swatch] }} />}{t.label}</span>
            <b className="big-number sm">{t.value}</b>
            {t.note ? <span className="muted small">{t.note}</span> : <Delta now={t.now} before={t.before} />}
            {t.note && <Delta now={t.now} before={t.before} />}
          </div>
        ))}
      </div>

      {(gaps.review > 0 || gaps.noSku > 0 || (gaps.unassigned ?? 0) > 0 || k.byKind.unsorted > 0) && (
        <div className="gap-chips" role="list" aria-label="To tidy up">
          {gaps.review > 0 && <Link role="listitem" className="gap-chip" to="/review">{gaps.review} need review</Link>}
          {(gaps.unassigned ?? 0) > 0 && <button role="listitem" className="gap-chip" onClick={onUnassigned}>{gaps.unassigned} not assigned to a business</button>}
          {gaps.noSku > 0 && <button role="listitem" className="gap-chip" onClick={onNoSku}>{gaps.noSku} inventory items without a SKU</button>}
          {k.byKind.unsorted > 0 && <Link role="listitem" className="gap-chip" to="/reports?tab=writeoffs">{money(k.byKind.unsorted)} not sorted into business/personal</Link>}
        </div>
      )}

      <div className="analytics-grid">
        <div className="card">
          <div className="row-between chart-head"><h2>Spend by month</h2><Legend /></div>
          <MonthChart receipts={cur.receipts} lines={cur.lines} />
        </div>
        <div className="card">
          <div className="chart-head"><h2>Top stores</h2></div>
          <StoreBars receipts={cur.receipts} lines={cur.lines} onStore={onStore} />
        </div>
      </div>

      {onCategory && <CategoryCards stats={cats} active={activeCategory} onCategory={onCategory} />}
    </section>
  );
}
