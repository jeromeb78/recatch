import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { download, toCsv } from "../lib/csv";
import { money, shortDate } from "../lib/format";
import { mileageRate, rulesFor } from "../lib/taxrules";
import { tripValue, type SuggestedTrip, type TaxProfile, type Trip, type WReceipt, merchantKey } from "../lib/writeoffs";
import { DownloadIcon } from "../components/Icons";

interface Props {
  year: number;
  receipts: WReceipt[];
  trips: Trip[];
  suggested: SuggestedTrip[];
  profile: TaxProfile;
  saveProfile: (next: TaxProfile) => Promise<void>;
  reload: () => void;
}

export default function Mileage({ year, receipts, trips, suggested, profile, saveProfile, reload }: Props) {
  const rules = rulesFor(year);
  const storeMiles = profile.store_miles ?? {};
  const stores = useMemo(() => {
    const by = new Map<string, { name: string; count: number }>();
    for (const r of receipts) {
      const k = merchantKey(r.merchant);
      if (!k) continue;
      const s = by.get(k) ?? { name: r.merchant ?? k, count: 0 };
      s.count++;
      by.set(k, s);
    }
    return [...by.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [receipts]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const keyOf = (t: SuggestedTrip) => `${t.trip_date}|${t.merchant_key}`;
  useEffect(() => {
    setPicked(new Set(suggested.filter((t) => t.likelyInStore && t.miles > 0).map(keyOf)));
  }, [suggested]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [manual, setManual] = useState({ trip_date: new Date().toISOString().slice(0, 10), destination: "", purpose: "", miles: "" });

  const loggedMiles = trips.reduce((a, t) => a + Number(t.miles), 0);
  const loggedValue = trips.reduce((a, t) => a + tripValue(t), 0);
  const chosen = suggested.filter((t) => picked.has(keyOf(t)) && t.miles > 0);
  const chosenValue = chosen.reduce((a, t) => a + tripValue(t), 0);

  async function insert(rows: Trip[]) {
    setBusy(true);
    setMsg(null);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("trips").insert(rows.map((t) => ({
      user_id: user!.id, trip_date: t.trip_date, destination: t.destination, purpose: t.purpose,
      miles: t.miles, merchant_key: t.merchant_key, receipt_ids: t.receipt_ids,
    })));
    setBusy(false);
    if (error) return setMsg(error.message);
    setMsg(`Added ${rows.length} trip${rows.length === 1 ? "" : "s"} to your log.`);
    reload();
  }

  async function remove(id: string) {
    const { error } = await supabase.from("trips").delete().eq("id", id);
    if (error) setMsg(error.message);
    else reload();
  }

  function exportLog() {
    download(`mileage-log-${year}.csv`, toCsv(
      trips.map((t) => ({
        date: t.trip_date, destination: t.destination, business_purpose: t.purpose, miles: Number(t.miles).toFixed(1),
        rate: mileageRate(t.trip_date).toFixed(3), deduction: tripValue(t).toFixed(2),
      })),
      ["date", "destination", "business_purpose", "miles", "rate", "deduction"],
    ));
  }

  return (
    <>
      <div className="kpis">
        <div className="card kpi"><span className="eyebrow">Logged business miles</span><b className="big-number sm">{loggedMiles.toLocaleString(undefined, { maximumFractionDigits: 1 })}</b><span className="muted small">{trips.length} trip{trips.length === 1 ? "" : "s"}</span></div>
        <div className="card kpi"><span className="eyebrow">Mileage write-off</span><b className="big-number sm">{money(loggedValue)}</b><span className="muted small">Schedule C line 9</span></div>
        <div className="card kpi"><span className="eyebrow">{year} IRS rate</span><b className="big-number sm">{rules.mileage.map((p) => `${p.cents}¢`).join(" → ")}</b>
          <span className="muted small">{rules.mileage.length > 1 ? `${rules.mileage[1].cents}¢ from ${shortDate(rules.mileage[1].from)}` : "per mile, all year"}</span></div>
      </div>

      <section className="card stack-sm">
        <h2>1 · Distance to each store</h2>
        <p className="muted small">Round trip from where you start (home or your office), in miles. Used to turn receipts into trips.</p>
        {stores.length === 0 ? <p className="muted">No receipts with a store for {year}.</p> : (
          <div className="mapping">
            {stores.map(([k, s]) => (
              <label key={k} className="map-row">
                <span>{s.name} <span className="muted small">· {s.count} receipt{s.count === 1 ? "" : "s"}</span></span>
                <span className="with-suffix">
                  <input type="number" min="0" step="0.1" inputMode="decimal" defaultValue={storeMiles[k] ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value === "" ? undefined : Math.max(0, Number(e.target.value));
                      const next = { ...storeMiles };
                      if (v == null) delete next[k];
                      else next[k] = v;
                      saveProfile({ ...profile, store_miles: next });
                    }} />
                  <span className="muted small">mi</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="card list-card">
        <div className="row-between table-tools">
          <h2>2 · Trips from your receipts</h2>
          <button className="btn sm primary" disabled={busy || !chosen.length} onClick={() => insert(chosen)}>
            Add {chosen.length} trip{chosen.length === 1 ? "" : "s"} · {money(chosenValue)}
          </button>
        </div>
        {suggested.length === 0 ? <p className="muted pad">Every receipt day for {year} is already in your log.</p> : (
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th /><th>Date</th><th>Store</th><th className="num">Miles</th><th className="num">Write-off</th><th className="hide-sm">Looks like</th></tr></thead>
              <tbody>
                {suggested.map((t) => (
                  <tr key={keyOf(t)}>
                    <td><input type="checkbox" aria-label={`Include ${t.destination} on ${t.trip_date}`} disabled={!t.miles}
                      checked={picked.has(keyOf(t))} onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(keyOf(t));
                        else next.delete(keyOf(t));
                        setPicked(next);
                      }} /></td>
                    <td className="nowrap">{shortDate(t.trip_date)}</td>
                    <td>{t.destination} <span className="muted small">· {t.receipts} receipt{t.receipts === 1 ? "" : "s"}</span></td>
                    <td className="num">{t.miles ? t.miles : <span className="warn-text small">set distance</span>}</td>
                    <td className="num">{t.miles ? money(tripValue(t)) : "—"}</td>
                    <td className="hide-sm small">{t.likelyInStore ? "Store visit" : <span className="muted">Delivery — include only if you drove</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">One trip per store per day. If you visited several stores in one drive, add that route by hand below instead.</p>
      </section>

      <section className="card list-card">
        <div className="row-between table-tools">
          <h2>3 · Mileage log</h2>
          <button className="btn sm" onClick={exportLog} disabled={!trips.length}><DownloadIcon size={16} />CSV</button>
        </div>
        <form className="row-wrap manual-trip" onSubmit={(e) => {
          e.preventDefault();
          const miles = Number(manual.miles);
          if (!manual.destination || !(miles > 0)) return setMsg("Enter a destination and miles.");
          insert([{ trip_date: manual.trip_date, destination: manual.destination, purpose: manual.purpose || "Business errand", miles, merchant_key: null, receipt_ids: [] }])
            .then(() => setManual({ ...manual, destination: "", purpose: "", miles: "" }));
        }}>
          <label className="field">Date<input type="date" value={manual.trip_date} onChange={(e) => setManual({ ...manual, trip_date: e.target.value })} /></label>
          <label className="field">Destination<input placeholder="Post office, supplier…" value={manual.destination} onChange={(e) => setManual({ ...manual, destination: e.target.value })} /></label>
          <label className="field">Business purpose<input placeholder="Ship orders" value={manual.purpose} onChange={(e) => setManual({ ...manual, purpose: e.target.value })} /></label>
          <label className="field">Miles<input type="number" min="0" step="0.1" inputMode="decimal" value={manual.miles} onChange={(e) => setManual({ ...manual, miles: e.target.value })} /></label>
          <button className="btn sm" disabled={busy}>Add trip</button>
        </form>
        {msg && <p className="muted small">{msg}</p>}
        {trips.length === 0 ? <p className="muted pad">No trips logged for {year} yet.</p> : (
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>Date</th><th>Destination</th><th className="hide-sm">Purpose</th><th className="num">Miles</th><th className="num">Write-off</th><th /></tr></thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{shortDate(t.trip_date)}</td>
                    <td>{t.destination}</td>
                    <td className="hide-sm muted small">{t.purpose}</td>
                    <td className="num">{Number(t.miles)}</td>
                    <td className="num">{money(tripValue(t))}</td>
                    <td><button className="link danger" title="Remove" onClick={() => t.id && remove(t.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          The IRS needs date, destination, business purpose and miles for each trip — this log has all four. Also note your
          odometer on Jan 1 and Dec 31. Commuting to a regular workplace doesn’t count.
        </p>
      </section>
    </>
  );
}
