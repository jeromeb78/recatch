import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { download, toCsv } from "../lib/csv";
import { money } from "../lib/format";
import { RULE_YEARS, rulesFor } from "../lib/taxrules";
import {
  directions, findOpportunities, FIXES, homeOfficeAmounts, lineLabel, runScenario, SCENARIO_INFO, SCENARIOS,
  type Opportunity, type Scenario, type SuggestedTrip, type TaxProfile, type Trip, type WLine, type YearInputs,
} from "../lib/writeoffs";
import { DownloadIcon } from "../components/Icons";

interface Props {
  year: number;
  lines: WLine[];
  trips: Trip[];
  suggested: SuggestedTrip[];
  profile: TaxProfile;
  saveProfile: (next: TaxProfile) => Promise<void>;
  reload: () => void;
  openTab: (tab: "mileage") => void;
  hasBusinessDescription: boolean;
}

const LINE_ORDER = ["cogs", "c8", "c9", "c10", "c13", "c15", "c17", "c18", "c20b", "c21", "c22", "c23", "c24a", "c24b", "c25", "c27a", "c30", "uncat"];

export default function WriteOffs({ year, lines, trips, suggested, profile, saveProfile, reload, openTab, hasBusinessDescription }: Props) {
  const rules = rulesFor(year);
  const inputs: YearInputs = profile.years?.[String(year)] ?? {};
  const scenario: Scenario = inputs.scenario ?? "balanced";

  const results = useMemo(
    () => Object.fromEntries(SCENARIOS.map((s) => [s, runScenario({ year, scenario: s, lines, trips, suggested, inputs })])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, lines, trips, suggested, JSON.stringify(inputs)],
  ) as Record<Scenario, ReturnType<typeof runScenario>>;
  const chosen = results[scenario];
  const ops = useMemo(
    () => findOpportunities({ year, lines, trips, suggested, inputs, storeMiles: profile.store_miles ?? {}, hasBusinessDescription }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, lines, trips, suggested, JSON.stringify(inputs), JSON.stringify(profile.store_miles), hasBusinessDescription],
  );
  const usedLines = LINE_ORDER.filter((k) => SCENARIOS.some((s) => results[s].lines[k]));

  const setInputs = (patch: Partial<YearInputs>) =>
    saveProfile({ ...profile, years: { ...(profile.years ?? {}), [String(year)]: { ...inputs, ...patch } } });

  function exportSummary() {
    const rows = usedLines.map((k) => ({
      schedule_c_line: lineLabel(k),
      conservative: results.conservative.lines[k]?.toFixed(2) ?? "0.00",
      balanced: results.balanced.lines[k]?.toFixed(2) ?? "0.00",
      maximum: results.maximum.lines[k]?.toFixed(2) ?? "0.00",
      how_calculated: [...new Set(chosen.contributions.filter((c) => c.line === k).map((c) => c.source))].join("; "),
    }));
    rows.push({
      schedule_c_line: "TOTAL", conservative: results.conservative.total.toFixed(2), balanced: results.balanced.total.toFixed(2),
      maximum: results.maximum.total.toFixed(2), how_calculated: `Chosen: ${SCENARIO_INFO[scenario].label}. ${chosen.assumptions.join(" ")}`,
    });
    download(`write-offs-${year}.csv`, toCsv(rows, ["schedule_c_line", "conservative", "balanced", "maximum", "how_calculated"]));
  }

  return (
    <>
      <section className="card hero">
        <span className="eyebrow">Estimated write-offs for {year} · {SCENARIO_INFO[scenario].label}</span>
        <span className="big-number">{money(chosen.total)}</span>
        <span className="muted small">
          Schedule C business expenses and cost of goods sold, using {year} IRS rules
          {rules.isEstimate ? ` (${year} figures aren’t published yet — using ${RULE_YEARS[RULE_YEARS.length - 1]} figures)` : ""}.
        </span>
        <div className="row-wrap no-print">
          <button className="btn sm" onClick={exportSummary}><DownloadIcon size={16} />Accountant summary (CSV)</button>
          <button className="btn sm" onClick={() => window.print()}>Print</button>
        </div>
      </section>

      {rules.notes.length > 0 && (
        <div className="banner ok">
          <b>What’s new for {rules.year}</b>
          <ul>{rules.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}

      <section>
        <div className="section-head"><h2>Choose how to claim</h2></div>
        <div className="scenarios" role="radiogroup" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <button key={s} role="radio" aria-checked={s === scenario} className={`card scenario ${s === scenario ? "on" : ""}`}
              onClick={() => setInputs({ scenario: s })}>
              <span className="row-between"><b>{SCENARIO_INFO[s].label}</b>{s === "balanced" && <span className="pill ok">Recommended</span>}</span>
              <span className="big-number sm">{money(results[s].total)}</span>
              <span className="muted small">{SCENARIO_INFO[s].blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <Opportunities ops={ops} lines={lines} reload={reload} openTab={openTab} />

      <section>
        <div className="section-head"><h2>By Schedule C line</h2></div>
        <div className="card list-card">
          <div className="scroll-x">
            <table className="data wo-table">
              <thead>
                <tr><th>Line</th>{SCENARIOS.map((s) => <th key={s} className={`num ${s === scenario ? "chosen" : ""}`}>{SCENARIO_INFO[s].label}</th>)}</tr>
              </thead>
              <tbody>
                {usedLines.map((k) => (
                  <tr key={k}>
                    <td>
                      {lineLabel(k)}
                      <span className="muted small">{[...new Set(chosen.contributions.filter((c) => c.line === k).map((c) => c.source))].join(" · ")}</span>
                    </td>
                    {SCENARIOS.map((s) => <td key={s} className={`num ${s === scenario ? "chosen" : ""}`}>{results[s].lines[k] ? money(results[s].lines[k]) : "—"}</td>)}
                  </tr>
                ))}
                {!usedLines.length && <tr><td colSpan={4} className="muted">Nothing deductible yet for {year}.</td></tr>}
              </tbody>
              <tfoot>
                <tr><td><b>Total</b></td>{SCENARIOS.map((s) => <td key={s} className={`num ${s === scenario ? "chosen" : ""}`}><b>{money(results[s].total)}</b></td>)}</tr>
              </tfoot>
            </table>
          </div>
        </div>
        {chosen.assumptions.length > 0 && (
          <ul className="muted small assumptions">{chosen.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        )}
      </section>

      <Setup year={year} inputs={inputs} setInputs={setInputs} />

      <Guide year={year} amounts={chosen.lines} />

      <p className="muted small">
        Estimates for organizing your records under {year} federal rules (figures checked {rules.verified}), not tax advice.
        State rules differ. Review with a tax professional before filing — they can confirm business-use percentages and
        elections for your situation.
      </p>
    </>
  );
}

/* ---------------- missed write-offs ---------------- */

function Opportunities({ ops, lines, reload, openTab }: { ops: Opportunity[]; lines: WLine[]; reload: () => void; openTab: (t: "mileage") => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const actionable = ops.filter((o) => o.kind !== "info");
  const potential = actionable.reduce((a, o) => a + (o.value ?? 0), 0);

  async function invoke(body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke("categorize-items", { body });
    if (error) {
      const b = await (error as { context?: Response }).context?.json?.().catch(() => null);
      throw new Error(b?.error ?? error.message);
    }
    return data;
  }

  async function run(work: () => Promise<void>) {
    setRunning(true);
    try {
      await work();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const categorize = () => run(async () => {
    setMsg("Categorizing…");
    for (let i = 0; i < 20; i++) {
      const data = await invoke({ limit: 100 });
      setMsg(`Categorized ${data.categorized}… ${data.remaining} left`);
      if (!data.remaining || !data.categorized) break;
    }
    setMsg("Done.");
  });

  const recheck = () => run(async () => {
    let after: string | undefined, total = 0;
    for (let i = 0; i < 30; i++) {
      setMsg(`Re-checking with Claude… ${total} done`);
      const data = await invoke({ recheck: true, limit: 100, after });
      total += data.categorized;
      if (!data.next) break;
      after = data.next;
    }
    setMsg(`Re-checked ${total} items.`);
  });

  const saveDescription = () => run(async () => {
    const text = description.trim();
    if (!text) throw new Error("Describe what you sell first.");
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("profiles").update({ business_description: text }).eq("user_id", user!.id);
    if (error) throw new Error(error.message);
    setRunning(false);
    await recheck();
  });

  const applyFix = (o: Opportunity) => run(async () => {
    if (o.action?.type !== "items" || !o.action.fix) return;
    const ids = o.action.ids.filter((id) => !unticked.has(id));
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await supabase.from("line_items").update(FIXES[o.action.fix].patch).in("id", ids.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
    setMsg(`Updated ${ids.length} item${ids.length === 1 ? "" : "s"}.`);
    setOpen(null);
  });

  return (
    <section>
      <div className="section-head">
        <h2>Missed write-offs</h2>
        {potential > 0 && <span className="muted small">up to ~{money(potential)} more to review</span>}
      </div>
      <div className="card op-list">
        {msg && <p className="banner ok small" role="status">{msg}</p>}
        {ops.map((o) => {
          const items = o.action?.type === "items" ? o.action : null;
          const chosen = items ? items.ids.filter((id) => !unticked.has(id)).length : 0;
          return (
            <div key={o.id} className={`op ${o.kind}`}>
              <div className="op-main">
                <b>{o.title}</b>
                <span className="muted small">{o.detail}</span>
                {o.action?.type === "describe" && (
                  <div className="stack-sm describe">
                    <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
                      placeholder="e.g. I buy Hot Wheels, Matchbox and other die-cast cars at Walmart and Target and resell them on my WooCommerce store. I also buy shipping supplies." />
                    <button className="btn sm primary" disabled={running} onClick={saveDescription}>{running ? "Working…" : "Save & re-check items with Claude"}</button>
                  </div>
                )}
                {items && open === o.id && (
                  <div className="op-items">
                    {items.ids.map((id) => {
                      const l = byId.get(id);
                      return l ? (
                        <label key={id} className="op-item">
                          {items.fix && (
                            <input type="checkbox" checked={!unticked.has(id)} onChange={(e) => {
                              const next = new Set(unticked);
                              if (e.target.checked) next.delete(id);
                              else next.add(id);
                              setUnticked(next);
                            }} />
                          )}
                          <span className="grow">
                            <Link to={`/receipts/${l.receipt_id}`}>{l.description}</Link>
                            <span className="muted small"> · {l.merchant} · {money(l.landed_total)}</span>
                          </span>
                        </label>
                      ) : null;
                    })}
                    {items.fix && (
                      <div className="row-wrap">
                        <button className="btn sm primary" disabled={running || !chosen} onClick={() => applyFix(o)}>
                          {FIXES[items.fix].label} ({chosen})
                        </button>
                        {o.id === "low-confidence" && <button className="btn sm" disabled={running} onClick={recheck}>Re-check with Claude instead</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="op-side">
                {o.value ? <span className="mono small">~{money(o.value)}</span> : null}
                {o.action?.type === "categorize" && <button className="btn sm primary" disabled={running} onClick={categorize}>{running ? "Working…" : "Categorize now"}</button>}
                {items && <button className="btn sm" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? "Hide" : items.fix ? "Review & fix" : "Show items"}</button>}
                {o.action?.type === "tab" && o.action.tab === "mileage" && <button className="btn sm primary" onClick={() => openTab("mileage")}>Open mileage</button>}
                {o.action?.type === "tab" && o.action.tab === "setup" && (
                  <button className="btn sm" onClick={() => document.getElementById("setup")?.scrollIntoView({ behavior: "smooth" })}>Answer</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- user answers ---------------- */

function NumField({ label, value, onSave, suffix, step = "any" }: { label: string; value?: number; onSave: (v: number | undefined) => void; suffix?: string; step?: string }) {
  const [v, setV] = useState(value != null ? String(value) : "");
  return (
    <label className="field">
      {label}
      <span className="with-suffix">
        <input type="number" inputMode="decimal" min="0" step={step} value={v} onChange={(e) => setV(e.target.value)}
          onBlur={() => onSave(v === "" ? undefined : Math.max(0, Number(v)))} />
        {suffix && <span className="muted small">{suffix}</span>}
      </span>
    </label>
  );
}

function Setup({ year, inputs, setInputs }: { year: number; inputs: YearInputs; setInputs: (p: Partial<YearInputs>) => void }) {
  const rules = rulesFor(year);
  const ho = inputs.homeOffice ?? {};
  const ph = inputs.phone ?? {}, net = inputs.internet ?? {}, f = inputs.fees ?? {}, inv = inputs.inventory ?? {}, car = inputs.vehicle ?? {};
  const hoAmt = homeOfficeAmounts(ho, rules);
  return (
    <section id="setup">
      <div className="section-head"><h2>Your answers for {year}</h2><span className="muted small">Saved as you go</span></div>
      <div className="setup-grid">
        <div className="card stack-sm">
          <h3>Home office</h3>
          <p className="muted small">A space used regularly and only for the business — packing, inventory storage, bookkeeping.</p>
          <div className="row-wrap">
            <NumField label="Office / storage area" suffix="sq ft" value={ho.sqft} onSave={(v) => setInputs({ homeOffice: { ...ho, sqft: v } })} />
            <NumField label="Whole home" suffix="sq ft" value={ho.homeSqft} onSave={(v) => setInputs({ homeOffice: { ...ho, homeSqft: v } })} />
          </div>
          <details>
            <summary className="small">Home costs for the regular method (yearly)</summary>
            <div className="row-wrap">
              <NumField label="Rent or mortgage interest" suffix="$/yr" value={ho.rent} onSave={(v) => setInputs({ homeOffice: { ...ho, rent: v } })} />
              <NumField label="Utilities" suffix="$/yr" value={ho.utilities} onSave={(v) => setInputs({ homeOffice: { ...ho, utilities: v } })} />
              <NumField label="Home insurance" suffix="$/yr" value={ho.insurance} onSave={(v) => setInputs({ homeOffice: { ...ho, insurance: v } })} />
              <NumField label="Repairs" suffix="$/yr" value={ho.repairs} onSave={(v) => setInputs({ homeOffice: { ...ho, repairs: v } })} />
            </div>
          </details>
          {(hoAmt.simplified > 0 || hoAmt.regular > 0) && (
            <p className="small">Simplified: <b>{money(hoAmt.simplified)}</b>{hoAmt.regular > 0 && <> · Regular: <b>{money(hoAmt.regular)}</b></>}</p>
          )}
        </div>

        <div className="card stack-sm">
          <h3>Phone &amp; internet</h3>
          <div className="row-wrap">
            <NumField label="Phone bill" suffix="$/mo" value={ph.monthly} onSave={(v) => setInputs({ phone: { ...ph, monthly: v } })} />
            <NumField label="Business use" suffix="%" step="1" value={ph.pct} onSave={(v) => setInputs({ phone: { ...ph, pct: Math.min(100, v ?? 0) } })} />
          </div>
          <div className="row-wrap">
            <NumField label="Internet bill" suffix="$/mo" value={net.monthly} onSave={(v) => setInputs({ internet: { ...net, monthly: v } })} />
            <NumField label="Business use" suffix="%" step="1" value={net.pct} onSave={(v) => setInputs({ internet: { ...net, pct: Math.min(100, v ?? 0) } })} />
          </div>
        </div>

        <div className="card stack-sm">
          <h3>Fees &amp; subscriptions <span className="muted small">(year totals)</span></h3>
          <div className="row-wrap">
            <NumField label="Selling platform fees" suffix="$" value={f.platform} onSave={(v) => setInputs({ fees: { ...f, platform: v } })} />
            <NumField label="Payment processing fees" suffix="$" value={f.payment} onSave={(v) => setInputs({ fees: { ...f, payment: v } })} />
            <NumField label="Software & subscriptions" suffix="$" value={f.software} onSave={(v) => setInputs({ fees: { ...f, software: v } })} />
            <NumField label="Advertising" suffix="$" value={f.advertising} onSave={(v) => setInputs({ fees: { ...f, advertising: v } })} />
            <NumField label="Other business costs" suffix="$" value={f.other} onSave={(v) => setInputs({ fees: { ...f, other: v } })} />
          </div>
        </div>

        <div className="card stack-sm">
          <h3>Inventory on hand <span className="muted small">(at cost)</span></h3>
          <div className="row-wrap">
            <NumField label={`Jan 1, ${year}`} suffix="$" value={inv.begin} onSave={(v) => setInputs({ inventory: { ...inv, begin: v } })} />
            <NumField label={`Dec 31, ${year}`} suffix="$" value={inv.end} onSave={(v) => setInputs({ inventory: { ...inv, end: v } })} />
          </div>
          <p className="muted small">Count unsold stock at what you paid. Only sold inventory is deductible.</p>
        </div>

        <div className="card stack-sm">
          <h3>Car <span className="muted small">(to compare with actual costs)</span></h3>
          <div className="row-wrap">
            <NumField label="Total miles driven this year" suffix="mi" value={car.totalMiles} onSave={(v) => setInputs({ vehicle: { ...car, totalMiles: v } })} />
            <NumField label="Gas, insurance, repairs, registration, lease" suffix="$/yr" value={car.costs} onSave={(v) => setInputs({ vehicle: { ...car, costs: v } })} />
          </div>
        </div>

        <div className="card stack-sm">
          <h3>Elections</h3>
          <label className="inline check">
            <input type="checkbox" checked={!!inputs.deMinimisElection} onChange={(e) => setInputs({ deMinimisElection: e.target.checked })} />
            I’ll attach the de minimis safe harbor statement (deduct items up to ${rules.deMinimis.toLocaleString()} in full)
          </label>
        </div>
      </div>
    </section>
  );
}

/* ---------------- how to claim ---------------- */

function Guide({ year, amounts }: { year: number; amounts: Record<string, number> }) {
  const all = directions(year);
  const relevant = all.filter((d) => amounts[d.line] || (d.line === "c22" && (amounts.c18 || amounts.c27a)));
  const rest = all.filter((d) => !relevant.includes(d));
  const Item = ({ d }: { d: (typeof all)[number] }) => (
    <details className="guide" open={relevant.includes(d)}>
      <summary><b>{d.title}</b>{amounts[d.line] ? <span className="mono small"> · {money(amounts[d.line])}</span> : null}</summary>
      <ol>{d.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <p className="small"><b>Keep:</b> {d.records} <a href={d.source} target="_blank" rel="noreferrer">IRS guidance ↗</a></p>
    </details>
  );
  return (
    <section>
      <div className="section-head"><h2>How to claim</h2></div>
      <div className="card stack-sm">
        <p className="small">
          Report these on <b>Schedule C (Form 1040)</b>. Tax software asks for the same lines; give your preparer the
          accountant summary and the mileage log. Keep receipts and records for at least 3 years after filing.
        </p>
        {relevant.map((d) => <Item key={d.line} d={d} />)}
        {rest.length > 0 && (
          <details>
            <summary className="small muted">Other write-offs ({rest.length})</summary>
            {rest.map((d) => <Item key={d.line} d={d} />)}
          </details>
        )}
      </div>
    </section>
  );
}
