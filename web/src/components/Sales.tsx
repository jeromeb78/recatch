import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { accountId, useAccount } from "../lib/account";
import { useBusinesses } from "../lib/businesses";
import { money, relative, shortDate } from "../lib/format";
import {
  callPayments, callSales, callShipping, saveImport, syncPayments, syncShipping, syncStore, useChannels, usePaymentAccounts, useShippingAccounts,
  type Channel, type PaymentAccount, type ShippingAccount,
} from "../lib/sales";
import { detectPreset, FIELD_LABEL, importSales, parseCsv, PRESETS, type Field, type ImportResult, type Mapping, type Preset } from "../lib/salesImport";

/** Settings → Sales: connect a WooCommerce store or import marketplace files, so reports can show profit. */
export function SalesSection() {
  const { can } = useAccount();
  const canSee = can("reports");
  const canEdit = can("reports", "edit");
  const { channels, reload } = useChannels(canSee);
  const { accounts, reload: reloadAccounts } = usePaymentAccounts(canSee);
  const { accounts: shippers, reload: reloadShippers } = useShippingAccounts(canSee);
  const { active: businesses } = useBusinesses();
  const [mode, setMode] = useState<null | "woo" | "stripe" | "easyship" | { importInto?: string }>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!channels?.length) return;
    Promise.all(channels.map(async (c) => {
      const { count } = await supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("channel_id", c.id);
      return [c.id, count ?? 0] as const;
    })).then((pairs) => setCounts(Object.fromEntries(pairs)));
  }, [channels]);

  if (!canSee) return null;
  return (
    <section className="card" id="sales">
      <h2>Sales</h2>
      <p className="muted small">
        Connect where you sell to see real profit: what you sold, minus what the goods cost (from your receipts), fees and expenses.
        If Stripe takes your payments, connect it too — Stripe's charges, refunds and fees then win over the store's numbers.
        Only totals, dates, SKUs and product names are copied — never customer names, emails, addresses or card details.
      </p>

      {channels === null ? <p className="muted">Loading…</p> : channels.length > 0 && (
        <ul className="channel-list">
          {channels.map((c) => (
            <ChannelRow key={c.id} c={c} orders={counts[c.id]} canEdit={canEdit} businesses={businesses} reload={reload}
              onImport={() => setMode({ importInto: c.id })} />
          ))}
        </ul>
      )}

      {accounts && accounts.length > 0 && (
        <ul className="channel-list">
          {accounts.map((a) => <ServiceRow key={a.id} a={a} cfg={STRIPE_CFG(a)} canEdit={canEdit} businesses={businesses} reload={reloadAccounts} />)}
        </ul>
      )}

      {shippers && shippers.length > 0 && (
        <ul className="channel-list">
          {shippers.map((a) => <ServiceRow key={a.id} a={a} cfg={EASYSHIP_CFG} canEdit={canEdit} businesses={businesses} reload={reloadShippers} />)}
        </ul>
      )}

      {canEdit && mode === null && (
        <div className="actions">
          <button className="primary" onClick={() => setMode("woo")}>Connect WooCommerce</button>
          <button onClick={() => setMode("stripe")}>Connect Stripe</button>
          <button onClick={() => setMode("easyship")}>Connect Easyship</button>
          <button onClick={() => setMode({})}>Import eBay, Etsy or Shopify sales</button>
        </div>
      )}
      {mode === "woo" && <ConnectWoo businesses={businesses} onDone={() => { setMode(null); reload(); }} />}
      {mode === "stripe" && <ConnectStripe businesses={businesses} onDone={() => { setMode(null); reloadAccounts(); }} />}
      {mode === "easyship" && <ConnectEasyship businesses={businesses} onDone={() => { setMode(null); reloadShippers(); }} />}
      {mode !== null && mode !== "woo" && mode !== "stripe" && mode !== "easyship" && (
        <ImportFile channels={(channels ?? []).filter((c) => c.kind === "csv")} businesses={businesses} into={mode.importInto}
          onDone={() => { setMode(null); reload(); }} />
      )}
    </section>
  );
}

function ChannelRow({ c, orders, canEdit, businesses, reload, onImport }: {
  c: Channel; orders: number | undefined; canEdit: boolean; businesses: { id: string; name: string }[]; reload: () => void; onImport: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [rekey, setRekey] = useState(false);

  async function sync() {
    setBusy("Syncing…");
    setMsg(null);
    try {
      const n = await syncStore(c.id, (k) => setBusy(`Syncing… ${k} orders`));
      setMsg(n ? `${n} order${n === 1 ? "" : "s"} updated` : "Up to date");
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(null);
    reload();
  }
  async function setBusiness(id: string) {
    const { error } = await supabase.from("sales_channels").update({ business_id: id || null }).eq("id", c.id);
    if (error) setMsg(error.message);
    reload();
  }
  async function disconnect() {
    const what = c.kind === "woocommerce" ? "Disconnect this store? Its saved keys and" : "Remove these imported sales? All";
    if (!confirm(`${what} ${orders ?? ""} orders copied into Receipt Catcher are deleted. Your store itself isn't changed.`)) return;
    const { error } = await supabase.from("sales_channels").delete().eq("id", c.id);
    if (error) setMsg(error.message);
    reload();
  }

  return (
    <li className="channel">
      <div className="row-between">
        <div className="grow">
          <b>{c.name}</b> <span className="pill">{c.kind === "woocommerce" ? "WooCommerce" : "Imported files"}</span>
          <div className="muted small">
            {orders !== undefined && `${orders.toLocaleString()} orders · `}
            {c.kind === "woocommerce"
              ? (c.backfill_cursor !== "done" ? "importing all orders…" : c.last_synced_at ? `synced ${relative(c.last_synced_at)}` : "not synced yet")
              : `added ${shortDate(c.created_at)}`}
          </div>
        </div>
        {canEdit && (
          <div className="actions tight">
            {c.kind === "woocommerce"
              ? <button className="btn sm" onClick={sync} disabled={!!busy}>{busy ?? (c.backfill_cursor !== "done" ? "Continue import" : "Sync now")}</button>
              : <button className="btn sm" onClick={onImport}>Import more</button>}
            <button className="link danger small" onClick={disconnect}>{c.kind === "woocommerce" ? "Disconnect" : "Remove"}</button>
          </div>
        )}
      </div>
      {businesses.length > 0 && (
        <label className="inline-select">
          <span className="muted small">Business</span>
          <select value={c.business_id ?? ""} onChange={(e) => setBusiness(e.target.value)} disabled={!canEdit}>
            <option value="">Not assigned</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}
      {c.status === "error" && (
        <p className="banner warn">
          {c.last_error ?? "The last sync failed."}{" "}
          {canEdit && c.kind === "woocommerce" && <button className="link" onClick={() => setRekey(true)}>Update keys</button>}
        </p>
      )}
      {rekey && <WooKeys channel={c.id} onDone={() => { setRekey(false); reload(); }} />}
      {msg && <p className="muted small">{msg}</p>}
    </li>
  );
}

interface ServiceConfig {
  table: "payment_accounts" | "shipping_accounts";
  countTable: "payments" | "shipments";
  noun: string;
  pill: string;
  role: string;
  sync: (id: string, onProgress: (n: number) => void) => Promise<number>;
  disconnect: string;
  rekeyLabel: string;
  Rekey: (p: { account: string; onDone: () => void }) => JSX.Element;
}

/** One connected service (Stripe, Easyship): status, sync, business, new key, disconnect. */
function ServiceRow({ a, cfg, canEdit, businesses, reload }: {
  a: { id: string; name: string; business_id: string | null; status: string; last_error: string | null; last_synced_at: string | null; backfill_cursor: string | null };
  cfg: ServiceConfig; canEdit: boolean; businesses: { id: string; name: string }[]; reload: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [rekey, setRekey] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    supabase.from(cfg.countTable).select("id", { count: "exact", head: true }).eq("account_id", a.id).then(({ count }) => setCount(count ?? 0));
  }, [a.id, a.last_synced_at, cfg.countTable]);

  async function sync() {
    setBusy("Syncing…");
    setMsg(null);
    try {
      const n = await cfg.sync(a.id, (k) => setBusy(`Syncing… ${k.toLocaleString()} ${cfg.noun}`));
      setMsg(n ? `${n.toLocaleString()} ${cfg.noun} updated` : "Up to date");
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(null);
    reload();
  }
  async function setBusiness(id: string) {
    const { error } = await supabase.from(cfg.table).update({ business_id: id || null }).eq("id", a.id);
    if (error) setMsg(error.message);
    reload();
  }
  async function disconnect() {
    if (!confirm(cfg.disconnect)) return;
    const { error } = await supabase.from(cfg.table).delete().eq("id", a.id);
    if (error) setMsg(error.message);
    reload();
  }

  return (
    <li className="channel">
      <div className="row-between">
        <div className="grow">
          <b>{a.name}</b> <span className="pill">{cfg.pill}</span>
          <div className="muted small">
            {count !== null && `${count.toLocaleString()} ${cfg.noun} · `}
            {a.backfill_cursor !== "done" ? "importing history…" : a.last_synced_at ? `synced ${relative(a.last_synced_at)}` : "not synced yet"}
            {` · ${cfg.role}`}
          </div>
        </div>
        {canEdit && (
          <div className="actions tight">
            <button className="btn sm" onClick={sync} disabled={!!busy}>{busy ?? (a.backfill_cursor !== "done" ? "Continue import" : "Sync now")}</button>
            <button className="link danger small" onClick={disconnect}>Disconnect</button>
          </div>
        )}
      </div>
      {businesses.length > 0 && (
        <label className="inline-select">
          <span className="muted small">Business</span>
          <select value={a.business_id ?? ""} onChange={(e) => setBusiness(e.target.value)} disabled={!canEdit}>
            <option value="">Not assigned</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}
      {a.status === "error" && (
        <p className="banner warn">
          {a.last_error ?? "The last sync failed."}{" "}
          {canEdit && <button className="link" onClick={() => setRekey(true)}>{cfg.rekeyLabel}</button>}
        </p>
      )}
      {rekey && <cfg.Rekey account={a.id} onDone={() => { setRekey(false); reload(); }} />}
      {msg && <p className="muted small">{msg}</p>}
    </li>
  );
}

const STRIPE_CFG = (a: PaymentAccount): ServiceConfig => ({
  table: "payment_accounts", countTable: "payments", noun: "payments", pill: `Stripe${a.livemode ? "" : " · test mode"}`,
  role: "source of truth for sales, refunds and fees", sync: syncPayments, rekeyLabel: "Use a new key", Rekey: StripeKey,
  disconnect: "Disconnect Stripe? Its saved key and the payments copied into Receipt Catcher are deleted. Nothing changes in Stripe.",
});
const EASYSHIP_CFG: ServiceConfig = {
  table: "shipping_accounts", countTable: "shipments", noun: "shipments", pill: "Easyship",
  role: "label costs checked against what customers paid", sync: syncShipping, rekeyLabel: "Use a new token", Rekey: EasyshipToken,
  disconnect: "Disconnect Easyship? Its saved token and the shipments copied into Receipt Catcher are deleted. Nothing changes in Easyship.",
};

function StripeHelp() {
  return (
    <ol className="muted small help-steps">
      <li>In Stripe, open <b>Developers → API keys</b> and click <b>Create restricted key</b> (choose “Providing this key to another website”
        if asked, and name it “Receipt Catcher”).</li>
      <li>Set <b>Charges and Refunds</b> to <b>Read</b> and <b>Balance</b> to <b>Read</b> (optionally <b>Disputes</b> to Read). Leave everything else as None.</li>
      <li>Create the key and paste it here (it starts with <span className="mono">rk_live_</span>). It's stored encrypted and can only read — it can't move money.</li>
    </ol>
  );
}

function StripeKey({ account, onDone }: { account: string; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callPayments({ action: "rekey", payment_account: account, key });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <form className="stack-sm" onSubmit={submit}>
      <StripeHelp />
      <label className="field">Restricted key<input required type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="rk_live_…" /></label>
      {error && <p className="error">{error}</p>}
      <div className="actions tight"><button className="primary" disabled={busy}>{busy ? "Checking…" : "Save key"}</button></div>
    </form>
  );
}

function ConnectStripe({ businesses, onDone }: { businesses: { id: string; name: string }[]; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [business, setBusiness] = useState(businesses[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("Checking the key…");
    setError(null);
    try {
      const r = await callPayments({ action: "connect", key, business: business || null });
      const id = (r.account as PaymentAccount).id;
      setBusy("Importing payments…");
      await syncPayments(id, (n) => setBusy(`Importing payments… ${n.toLocaleString()}`));
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <form className="stack-sm sales-form" onSubmit={submit}>
      <h3>Connect Stripe</h3>
      <p className="muted small">
        Stripe becomes the source of truth for money: each WooCommerce order takes Stripe's charged amount, refunds and actual fee,
        and payments with no store order still count as sales. Products and SKUs still come from the store.
      </p>
      <StripeHelp />
      <label className="field">Restricted key<input required type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="rk_live_…" /></label>
      {businesses.length > 0 && (
        <label className="field">Payments with no store order belong to
          <select value={business} onChange={(e) => setBusiness(e.target.value)}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="">Not assigned</option>
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" disabled={!!busy}>{busy ?? "Connect and import payments"}</button>
        <button type="button" className="link" onClick={onDone} disabled={!!busy}>Cancel</button>
      </div>
    </form>
  );
}

function EasyshipHelp() {
  return (
    <ol className="muted small help-steps">
      <li>In Easyship, open <b>Connect → API Integration</b> (or Settings → API) and create an integration named “Receipt Catcher”.</li>
      <li>Copy its <b>production</b> API access token (it starts with <span className="mono">prod_</span>). If you can choose scopes, shipment
        read access is all that's needed.</li>
      <li>Paste it here. It's stored encrypted and only used to read shipments — never to buy or cancel labels.</li>
    </ol>
  );
}

function EasyshipToken({ account, onDone }: { account: string; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callShipping({ action: "rekey", shipping_account: account, token });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <form className="stack-sm" onSubmit={submit}>
      <EasyshipHelp />
      <label className="field">API access token<input required type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="prod_…" /></label>
      {error && <p className="error">{error}</p>}
      <div className="actions tight"><button className="primary" disabled={busy}>{busy ? "Checking…" : "Save token"}</button></div>
    </form>
  );
}

function ConnectEasyship({ businesses, onDone }: { businesses: { id: string; name: string }[]; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [business, setBusiness] = useState(businesses[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("Checking the token…");
    setError(null);
    try {
      const r = await callShipping({ action: "connect", token, business: business || null });
      const id = (r.account as ShippingAccount).id;
      setBusy("Importing shipments…");
      await syncShipping(id, (n) => setBusy(`Importing shipments… ${n.toLocaleString()}`));
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <form className="stack-sm sales-form" onSubmit={submit}>
      <h3>Connect Easyship</h3>
      <p className="muted small">
        Each label is matched to the store order it was bought for, so Profit shows what shipping really cost against what the customer
        paid (as confirmed by Stripe) — plus labels with no order, paid orders with no label, and refunded orders that were already shipped.
        Label costs count as a shipping expense.
      </p>
      <EasyshipHelp />
      <label className="field">API access token<input required type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="prod_…" /></label>
      {businesses.length > 0 && (
        <label className="field">Labels with no store order belong to
          <select value={business} onChange={(e) => setBusiness(e.target.value)}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="">Not assigned</option>
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" disabled={!!busy}>{busy ?? "Connect and import shipments"}</button>
        <button type="button" className="link" onClick={onDone} disabled={!!busy}>Cancel</button>
      </div>
    </form>
  );
}

function WooHelp() {
  return (
    <ol className="muted small help-steps">
      <li>In WordPress, open <b>WooCommerce → Settings → Advanced → REST API</b> and click <b>Add key</b>.</li>
      <li>Description “Receipt Catcher”, Permissions <b>Read</b> (read-only is all that's needed), then <b>Generate API key</b>.</li>
      <li>Copy the Consumer key and Consumer secret here. They're stored encrypted and only used to read orders and products.</li>
    </ol>
  );
}

function WooKeys({ channel, onDone }: { channel: string; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callSales({ action: "rekey", channel, key, secret });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <form className="stack-sm" onSubmit={submit}>
      <WooHelp />
      <div className="row-wrap">
        <label className="field">Consumer key<input required autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="ck_…" /></label>
        <label className="field">Consumer secret<input required type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="cs_…" /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions tight"><button className="primary" disabled={busy}>{busy ? "Checking…" : "Save keys"}</button></div>
    </form>
  );
}

function ConnectWoo({ businesses, onDone }: { businesses: { id: string; name: string }[]; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [business, setBusiness] = useState(businesses[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("Checking the store…");
    setError(null);
    try {
      const r = await callSales({ action: "connect", store_url: url, key, secret, business: business || null });
      const channel = (r.channel as Channel).id;
      setBusy("Copying orders…");
      await syncStore(channel, (n) => setBusy(`Copying orders… ${n.toLocaleString()}`));
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <form className="stack-sm sales-form" onSubmit={submit}>
      <h3>Connect WooCommerce</h3>
      <WooHelp />
      <label className="field">Store address<input required inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourstore.com" /></label>
      <div className="row-wrap">
        <label className="field">Consumer key<input required autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="ck_…" /></label>
        <label className="field">Consumer secret<input required type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="cs_…" /></label>
      </div>
      {businesses.length > 0 && (
        <label className="field">Sales belong to
          <select value={business} onChange={(e) => setBusiness(e.target.value)}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="">Not assigned</option>
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" disabled={!!busy}>{busy ?? "Connect and copy orders"}</button>
        <button type="button" className="link" onClick={onDone} disabled={!!busy}>Cancel</button>
      </div>
    </form>
  );
}

function ImportFile({ channels, businesses, into, onDone }: {
  channels: Channel[]; businesses: { id: string; name: string }[]; into?: string; onDone: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preset, setPreset] = useState<Preset>("ebay");
  const [map, setMap] = useState<Mapping>({});
  const [target, setTarget] = useState(into ?? "new");
  const [business, setBusiness] = useState(businesses[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const header = useMemo(() => (text ? parseCsv(text.slice(0, 20000))[0] ?? [] : []), [text]);
  const result = useMemo<ImportResult | { error: string } | null>(() => (text ? importSales(text, preset, map) : null), [text, preset, map]);
  const ok = result && !("error" in result) ? result : null;
  const summary = useMemo(() => ok && {
    orders: ok.orders.filter((o) => o.lines.length).length,
    sales: ok.orders.filter((o) => o.status === "paid" || o.status === "refunded").reduce((a, o) => a + o.items_total + o.shipping_charged - o.refunded, 0),
    fees: ok.orders.reduce((a, o) => a + o.fees, 0),
    items: ok.orders.reduce((a, o) => a + o.lines.length, 0),
  }, [ok]);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return setError("That file is over 20 MB. Download a shorter date range.");
    setError(null);
    const t = await file.text();
    setFileName(file.name);
    setText(t);
    const p = detectPreset(parseCsv(t.slice(0, 20000)));
    setPreset(p);
    if (target === "new") {
      const existing = channels.find((c) => c.name === PRESETS[p].channel);
      if (existing) setTarget(existing.id);
    }
  }

  async function run() {
    if (!ok) return;
    setBusy("Saving…");
    setError(null);
    try {
      let channelId = target;
      if (target === "new") {
        const { data, error } = await supabase.from("sales_channels")
          .insert({ user_id: accountId(), kind: "csv", name: PRESETS[preset].channel, business_id: business || null }).select("id").single();
        if (error) throw new Error(error.message);
        channelId = data.id;
      }
      const bizOf = target === "new" ? business || null : channels.find((c) => c.id === target)?.business_id ?? null;
      await saveImport(channelId, bizOf, ok.orders, (n) => setBusy(`Saving… ${n.toLocaleString()} of ${ok.orders.length.toLocaleString()}`));
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm sales-form">
      <h3>Import a sales file</h3>
      <div className="row-wrap">
        <label className="field">File type
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {(Object.keys(PRESETS) as Preset[]).map((p) => <option key={p} value={p}>{PRESETS[p].label}</option>)}
          </select>
        </label>
        <label className="field">CSV file
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
      </div>
      <p className="muted small">{PRESETS[preset].how}</p>

      {preset === "generic" && header.length > 0 && (
        <div className="mapping">
          {(Object.keys(FIELD_LABEL) as Field[]).map((f) => (
            <label key={f} className="map-row">
              <span>{FIELD_LABEL[f]}{["date", "name", "total"].includes(f) ? " *" : ""}</span>
              <select value={map[f] ?? ""} onChange={(e) => setMap({ ...map, [f]: e.target.value || undefined })}>
                <option value="">—</option>
                {header.map((h, i) => <option key={i} value={h}>{h}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      {text && (
        <div className="row-wrap">
          <label className="field">Add to
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="new">New: {PRESETS[preset].channel}</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {target === "new" && businesses.length > 0 && (
            <label className="field">Sales belong to
              <select value={business} onChange={(e) => setBusiness(e.target.value)}>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="">Not assigned</option>
              </select>
            </label>
          )}
        </div>
      )}

      {result && "error" in result && <p className="error">{result.error}</p>}
      {ok && summary && (
        <div className="import-preview">
          <b>{fileName}</b>
          <span>{summary.orders.toLocaleString()} orders · {summary.items.toLocaleString()} items{ok.from && ` · ${shortDate(ok.from)} – ${shortDate(ok.to)}`}</span>
          <span>Sales {money(summary.sales)}{summary.fees > 0 && ` · fees ${money(summary.fees)}`}</span>
          {ok.warnings.map((w) => <span key={w} className="muted small">{w}</span>)}
          <span className="muted small">Importing the same orders again updates them — nothing is counted twice.</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions tight">
        <button className="primary" onClick={run} disabled={!ok || !ok.orders.length || !!busy}>{busy ?? `Import ${ok ? ok.orders.length.toLocaleString() + " orders" : ""}`}</button>
        <button type="button" className="link" onClick={onDone} disabled={!!busy}>Cancel</button>
      </div>
    </div>
  );
}
