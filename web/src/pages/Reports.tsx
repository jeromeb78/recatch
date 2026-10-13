import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { download, toCsv } from "../lib/csv";
import { money, shortDate } from "../lib/format";
import { TAX_LINES } from "../lib/tax";
import { suggestTrips, type TaxProfile, type Trip, type WLine, type WReceipt } from "../lib/writeoffs";
import WriteOffs from "./WriteOffs";
import Mileage from "./Mileage";
import {
  buildExport, DEFAULT_ACCOUNTS, DEFAULT_SETTINGS, PRESETS,
  type ExportLine, type ExportReceipt, type ExportSettings, type PresetKey,
} from "../lib/exports";
import { DownloadIcon } from "../components/Icons";
import { accountId, useAccount } from "../lib/account";

interface InvLine extends ExportLine, Omit<WLine, keyof ExportLine | "quantity"> {
  id: string;
  units: number;
  item_total: number | null;
  category: string | null;
}

type Tab = "writeoffs" | "mileage" | "inventory" | "export";
const TABS: [Tab, string][] = [["writeoffs", "Write-offs"], ["mileage", "Mileage"], ["inventory", "Inventory & COGS"], ["export", "Export"]];
const PAGE = 1000;

function yearRange(year: string): [string, string] | null {
  return year === "all" ? null : [`${year}-01-01`, `${year}-12-31`];
}

async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = raw === "taxes" ? "writeoffs" : TABS.some(([k]) => k === raw) ? (raw as Tab) : "writeoffs";
  const thisYear = new Date().getFullYear();
  const year = params.get("year") || String(thisYear);
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    setParams(p, { replace: true });
  };

  const [lines, setLines] = useState<InvLine[] | null>(null);
  const [receipts, setReceipts] = useState<(ExportReceipt & WReceipt)[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [profile, setProfile] = useState<TaxProfile>({});
  const [hasDescription, setHasDescription] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLines(null);
    setError(null);
    const range = yearRange(year);
    try {
      const [ls, rs, ts, pr] = await Promise.all([
        fetchAll<InvLine>((a, b) => {
          let q = supabase.from("inventory_lines").select("*").eq("user_id", accountId()).order("purchase_date", { ascending: false }).range(a, b);
          if (range) q = q.gte("purchase_date", range[0]).lte("purchase_date", range[1]);
          return q;
        }),
        fetchAll<ExportReceipt & WReceipt>((a, b) => {
          let q = supabase.from("receipts").select("id, purchase_date, merchant, order_number, total, shipping, document_type, payment_method")
            .eq("user_id", accountId()).order("purchase_date", { ascending: true }).range(a, b);
          if (range) q = q.gte("purchase_date", range[0]).lte("purchase_date", range[1]);
          return q;
        }),
        fetchAll<Trip>((a, b) => {
          let q = supabase.from("trips").select("id, trip_date, destination, purpose, miles, merchant_key, receipt_ids")
            .eq("user_id", accountId()).order("trip_date", { ascending: true }).range(a, b);
          if (range) q = q.gte("trip_date", range[0]).lte("trip_date", range[1]);
          return q;
        }),
        supabase.from("profiles").select("tax_profile, business_description").eq("user_id", accountId()).maybeSingle(),
      ]);
      setLines(ls);
      setReceipts(rs);
      setTrips(ts);
      setProfile(((pr.data?.tax_profile ?? {}) as TaxProfile));
      setHasDescription(!!pr.data?.business_description?.trim());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const canEdit = useAccount().can("reports", "edit");
  const saveProfile = useCallback(async (next: TaxProfile) => {
    setProfile(next);
    // View-only members can try what-ifs; nothing is saved to the account.
    if (!canEdit) return;
    const { error } = await supabase.from("profiles").update({ tax_profile: next }).eq("user_id", accountId());
    if (error) setError(error.message);
  }, [canEdit]);

  const suggested = useMemo(
    () => (receipts ? suggestTrips(receipts, trips, profile.store_miles ?? {}) : []),
    [receipts, trips, profile.store_miles],
  );
  const needsYear = (tab === "writeoffs" || tab === "mileage") && year === "all";

  return (
    <div className="stack">
      <div className="page-head row-between">
        <h1>Reports</h1>
        <label className="inline-select">
          <span className="muted small">Period</span>
          <select value={year} onChange={(e) => setParam("year", e.target.value)}>
            {[0, 1, 2, 3].map((d) => <option key={d} value={thisYear - d}>{thisYear - d}</option>)}
            <option value="all">All time</option>
          </select>
        </label>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setParam("tab", k)}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {needsYear ? (
        <p className="muted">Write-offs follow each tax year’s rules — pick a year above.</p>
      ) : !lines || !receipts ? <p className="muted">Loading…</p> : tab === "writeoffs" ? (
        <WriteOffs year={Number(year)} lines={lines as unknown as WLine[]} trips={trips} suggested={suggested}
          profile={profile} saveProfile={saveProfile} reload={load} openTab={(t) => setParam("tab", t)}
          hasBusinessDescription={hasDescription} />
      ) : tab === "mileage" ? (
        <Mileage year={Number(year)} receipts={receipts} trips={trips} suggested={suggested}
          profile={profile} saveProfile={saveProfile} reload={load} />
      ) : tab === "inventory" ? (
        <Inventory lines={lines} year={year} />
      ) : (
        <Exporter lines={lines} receipts={receipts} year={year} />
      )}
    </div>
  );
}

/* ---------------- Inventory & COGS ---------------- */

interface SkuRow {
  sku: string;
  description: string;
  units: number;
  spend: number;
  avgUnit: number;
  lastUnit: number;
  lastDate: string | null;
  purchases: number;
  stores: string;
}

function Inventory({ lines, year }: { lines: InvLine[]; year: string }) {
  const [q, setQ] = useState("");
  const inventory = lines.filter((l) => l.tax_line === "cogs" || l.woo_sku);
  const unmapped = inventory.filter((l) => !l.woo_sku);

  const rows = useMemo(() => {
    const by = new Map<string, InvLine[]>();
    for (const l of inventory) if (l.woo_sku) by.set(l.woo_sku, [...(by.get(l.woo_sku) ?? []), l]);
    const out: SkuRow[] = [];
    for (const [sku, ls] of by) {
      const units = ls.reduce((a, l) => a + Number(l.units), 0);
      const spend = ls.reduce((a, l) => a + Number(l.landed_total ?? 0), 0);
      const latest = [...ls].sort((a, b) => (b.purchase_date ?? "").localeCompare(a.purchase_date ?? ""))[0];
      out.push({
        sku,
        description: latest.description,
        units,
        spend,
        avgUnit: units ? spend / units : 0,
        lastUnit: Number(latest.units) ? Number(latest.landed_total ?? 0) / Number(latest.units) : 0,
        lastDate: latest.purchase_date,
        purchases: ls.length,
        stores: [...new Set(ls.map((l) => l.merchant).filter(Boolean))].join(", "),
      });
    }
    return out.sort((a, b) => b.spend - a.spend);
  }, [inventory]);

  const shown = rows.filter((r) => !q || `${r.sku} ${r.description} ${r.stores}`.toLowerCase().includes(q.toLowerCase()));
  const totalSpend = inventory.reduce((a, l) => a + Number(l.landed_total ?? 0), 0);
  const totalUnits = inventory.reduce((a, l) => a + Number(l.units), 0);
  const unmappedSpend = unmapped.reduce((a, l) => a + Number(l.landed_total ?? 0), 0);

  function exportCsv() {
    download(`inventory-costs-${year}.csv`, toCsv(
      rows.map((r) => ({ ...r, spend: r.spend.toFixed(2), avgUnit: r.avgUnit.toFixed(4), lastUnit: r.lastUnit.toFixed(4) })),
      ["sku", "description", "units", "spend", "avgUnit", "lastUnit", "lastDate", "purchases", "stores"],
    ));
  }

  return (
    <>
      <div className="kpis">
        <div className="card kpi"><span className="eyebrow">Inventory purchases</span><b className="big-number sm">{money(totalSpend)}</b><span className="muted small">landed: incl. tax &amp; shipping</span></div>
        <div className="card kpi"><span className="eyebrow">Units bought</span><b className="big-number sm">{totalUnits.toLocaleString()}</b><span className="muted small">{rows.length} SKUs</span></div>
        <div className="card kpi"><span className="eyebrow">Avg cost / unit</span><b className="big-number sm">{money(totalUnits ? totalSpend / totalUnits : 0)}</b><span className="muted small">across all SKUs</span></div>
      </div>

      {unmapped.length > 0 && (
        <Link to="/review" className="review-banner">
          <span className="count">{unmapped.length}</span>
          <span className="grow">inventory items ({money(unmappedSpend)}) have no Woo SKU yet</span>
          <span className="strong">Map</span>
        </Link>
      )}

      <section className="card list-card">
        <div className="table-tools">
          <input type="search" aria-label="Search SKUs" placeholder="Search SKU, item or store…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={exportCsv} disabled={!rows.length}><DownloadIcon size={16} />CSV</button>
        </div>
        {rows.length === 0 ? (
          <p className="muted pad">No inventory yet. Items count as inventory when they have a Woo SKU or the “Inventory purchases (COGS)” tax line.</p>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr><th>SKU</th><th>Item</th><th className="num">Units</th><th className="num">Spend</th><th className="num">Avg / unit</th><th className="num hide-sm">Last / unit</th><th className="hide-sm">Last bought</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.sku}>
                    <td className="mono">{r.sku}</td>
                    <td><span className="clip">{r.description}</span><span className="muted small">{r.purchases} purchase{r.purchases === 1 ? "" : "s"} · {r.stores}</span></td>
                    <td className="num">{r.units.toLocaleString()}</td>
                    <td className="num">{money(r.spend)}</td>
                    <td className="num">{money(r.avgUnit)}</td>
                    <td className={`num hide-sm ${r.lastUnit > r.avgUnit * 1.1 ? "warn-text" : ""}`}>{money(r.lastUnit)}</td>
                    <td className="nowrap hide-sm">{shortDate(r.lastDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small">
        Costs are “landed”: each order’s tax, shipping and discounts are spread across its items by price, and pack sizes
        (e.g. a 24-count case) are counted as units. This is purchases for the period — your COGS for taxes is beginning
        inventory + purchases − ending inventory.
      </p>
    </>
  );
}

/* ---------------- Accounting export ---------------- */

function Exporter({ lines, receipts, year }: { lines: InvLine[]; receipts: ExportReceipt[]; year: string }) {
  const [preset, setPreset] = useState<PresetKey>("qbo_items");
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<string | null>(null);
  const canEdit = useAccount().can("reports", "edit");

  useEffect(() => {
    supabase.from("profiles").select("export_settings").eq("user_id", accountId()).maybeSingle().then(({ data }) => {
      const s = (data?.export_settings ?? {}) as Partial<ExportSettings>;
      setSettings({ ...DEFAULT_SETTINGS, ...s, accounts: { ...DEFAULT_ACCOUNTS, ...(s.accounts ?? {}) } });
    });
  }, []);

  async function save(next: ExportSettings) {
    setSettings(next);
    if (!canEdit) return; // view-only: applies to this download, not saved
    const { error } = await supabase.from("profiles").update({ export_settings: next }).eq("user_id", accountId());
    setSaved(error ? error.message : "Saved");
    setTimeout(() => setSaved(null), 1500);
  }

  const usedLines = [...new Set(lines.map((l) => l.tax_line ?? "none"))];

  return (
    <>
      <section className="card stack-sm">
        <label className="field">Format
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetKey)}>
            {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
        </label>
        <div className="row-wrap">
          <label className="field">Date format
            <select value={settings.dateFormat} onChange={(e) => save({ ...settings, dateFormat: e.target.value as ExportSettings["dateFormat"] })}>
              <option>MM/DD/YYYY</option><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option>
            </select>
          </label>
          {preset === "xero_bills" && (
            <label className="field">Xero tax type
              <input value={settings.xeroTaxType} onChange={(e) => setSettings({ ...settings, xeroTaxType: e.target.value })}
                onBlur={() => save(settings)} />
            </label>
          )}
          <label className="inline check">
            <input type="checkbox" checked={settings.excludePersonal} onChange={(e) => save({ ...settings, excludePersonal: e.target.checked })} />
            Leave out personal items
          </label>
        </div>
        <button className="btn primary" onClick={() => download(`${PRESETS[preset].file}-${year}.csv`, buildExport(preset, receipts, lines, settings))}
          disabled={!receipts.length}>
          <DownloadIcon size={16} />Download {receipts.length} receipt{receipts.length === 1 ? "" : "s"}
        </button>
        <p className="muted small">
          Bank formats have one row per receipt (purchases negative, refunds positive). Itemized formats have one row per
          item with its landed amount and the account below. Check the columns against your QuickBooks or Xero import screen
          the first time.
        </p>
      </section>

      <section className="card">
        <div className="row-between"><h2>Account mapping</h2>{saved && <span className="ok small">{saved}</span>}</div>
        <p className="muted small">Which account in your books each tax line goes to. Use the account name (QuickBooks) or code (Xero).</p>
        <div className="mapping">
          {Object.keys(DEFAULT_ACCOUNTS).filter((k) => usedLines.includes(k) || ["cogs", "c22", "c18", "c27a", "none"].includes(k)).map((k) => (
            <label key={k} className="map-row">
              <span>{k === "none" ? "Not categorized" : TAX_LINES[k]}</span>
              <input value={settings.accounts[k] ?? ""} onChange={(e) => setSettings({ ...settings, accounts: { ...settings.accounts, [k]: e.target.value } })}
                onBlur={() => save(settings)} />
            </label>
          ))}
        </div>
      </section>
    </>
  );
}
