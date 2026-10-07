import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { date, relative } from "../lib/format";
import type { Connection } from "../lib/types";
import { AccountSection, BusinessProfile, ExtensionSection } from "../components/SettingsSections";

const INBOUND = (import.meta.env.VITE_INBOUND_ADDRESS as string | undefined) ?? "";

function forwardingAddress(token: string): string {
  const [local, domain] = INBOUND.split("@");
  return local && domain ? `${local}+${token}@${domain}` : "";
}

interface SyncSummary {
  email: string;
  receipts: number;
  duplicates: number;
  skipped: number;
  errors: number;
  remaining: boolean;
  error?: string;
}

async function invokeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  const body = await ctx?.json?.().catch(() => null);
  return body?.error ?? (error as Error).message;
}

export default function Settings({ userId, email }: { userId: string; email: string }) {
  const [params, setParams] = useSearchParams();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadConnections = useCallback(async () => {
    const { data } = await supabase
      .from("email_connections")
      .select("id, email, status, last_error, sync_from, last_synced_at")
      .order("created_at");
    setConnections((data ?? []) as Connection[]);
  }, []);

  useEffect(() => {
    loadConnections();
    supabase.from("profiles").select("inbound_token").eq("user_id", userId).single()
      .then(({ data }) => setToken(data?.inbound_token ?? null));
  }, [loadConnections, userId]);

  // Result of the Google OAuth round-trip.
  useEffect(() => {
    const gmail = params.get("gmail");
    if (!gmail) return;
    setNotice(gmail === "connected"
      ? { kind: "ok", text: `Connected ${params.get("email") ?? "Gmail"}. Run a backfill to pull older receipts.` }
      : { kind: "error", text: `Gmail connection failed (${params.get("reason") ?? "unknown"}).` });
    setParams({}, { replace: true });
  }, [params, setParams]);

  async function connectGmail() {
    setBusy("connect");
    const { data, error } = await supabase.functions.invoke("gmail-oauth", { method: "POST" });
    if (error) {
      setNotice({ kind: "error", text: await invokeError(error) });
      setBusy(null);
      return;
    }
    window.location.href = data.url;
  }

  async function sync(backfillDays?: number) {
    setBusy(backfillDays ? "backfill" : "sync");
    setNotice(null);
    const { data, error } = await supabase.functions.invoke("gmail-sync", {
      body: backfillDays ? { backfill_days: backfillDays } : {},
    });
    setBusy(null);
    await loadConnections();
    if (error) return setNotice({ kind: "error", text: await invokeError(error) });
    const results = (data.connections ?? []) as SyncSummary[];
    const text = results.map((r) =>
      r.error
        ? `${r.email}: ${r.error}`
        : `${r.email}: ${r.receipts} new, ${r.duplicates} duplicate, ${r.skipped} not receipts` +
          (r.errors ? `, ${r.errors} failed` : "") +
          (r.remaining ? " — more to go, click again or let the 30-min sync catch up" : ""),
    ).join("\n");
    setNotice({ kind: results.some((r) => r.error) ? "error" : "ok", text: text || "No Gmail accounts connected." });
  }

  async function disconnect(c: Connection) {
    if (!confirm(`Disconnect ${c.email}? Receipts already captured are kept.`)) return;
    await supabase.from("email_connections").delete().eq("id", c.id);
    loadConnections();
  }

  const address = token ? forwardingAddress(token) : "";

  return (
    <div className="narrow">
      <h1>Settings</h1>
      {notice && <pre className={`banner ${notice.kind === "ok" ? "ok" : "warn"}`}>{notice.text}</pre>}

      <section className="card">
        <h2>Gmail</h2>
        <p className="muted small">
          Read-only access. Every 30 minutes, receipt emails from known store domains (and their PDF attachments) are captured.
        </p>
        {connections.map((c) => (
          <div key={c.id} className="conn">
            <div>
              <strong>{c.email}</strong>{" "}
              <span className={`pill ${c.status === "active" ? "ok" : "warn"}`}>{c.status}</span>
              <div className="muted small">
                Last synced {relative(c.last_synced_at)} · searching since {date(c.sync_from)}
              </div>
              {c.last_error && <div className="error small">{c.last_error}</div>}
            </div>
            <button className="link danger" onClick={() => disconnect(c)}>Disconnect</button>
          </div>
        ))}
        <div className="actions">
          <button className="primary" onClick={connectGmail} disabled={!!busy}>
            {busy === "connect" ? "Redirecting…" : connections.length ? "Connect another Gmail" : "Connect Gmail"}
          </button>
          {connections.length > 0 && (
            <>
              <button onClick={() => sync()} disabled={!!busy}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
              <button onClick={() => sync(365)} disabled={!!busy}>
                {busy === "backfill" ? "Backfilling…" : "Backfill 12 months"}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Forwarding address</h2>
        {address ? (
          <>
            <div className="copy">
              <code>{address}</code>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >{copied ? "Copied" : "Copy"}</button>
            </div>
            <p className="muted small">
              Forward receipt emails here from any inbox, or email a photo of a paper receipt. Tip: add a Gmail/Outlook
              filter that auto-forwards mail from your stores to this address.
            </p>
          </>
        ) : (
          <p className="muted">{INBOUND ? "Loading…" : "Set VITE_INBOUND_ADDRESS to show your forwarding address."}</p>
        )}
      </section>

      <ExtensionSection userId={userId} />
      <BusinessProfile userId={userId} />
      <Categories />
      <AccountSection email={email} />
    </div>
  );
}

function Categories() {
  const { categories, reload } = useCategories();
  const [name, setName] = useState("");
  const [business, setBusiness] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("categories").insert({ user_id: user!.id, name: name.trim(), is_business: business });
    if (error) return setError(error.code === "23505" ? "That category already exists." : error.message);
    setName("");
    setBusiness(false);
    setError(null);
    reload();
  }

  async function patch(id: string, values: Record<string, unknown>) {
    const { error } = await supabase.from("categories").update(values).eq("id", id);
    if (error) setError(error.message);
    reload();
  }

  async function remove(id: string, n: string) {
    if (!confirm(`Delete “${n}”? Receipts in it become uncategorized.`)) return;
    await supabase.from("categories").delete().eq("id", id);
    reload();
  }

  return (
    <section className="card">
      <h2>Categories</h2>
      <p className="muted small">Business categories roll up into the Business total.</p>
      <table className="cats">
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td>
                <input type="color" value={c.color ?? "#6b7280"} onChange={(e) => patch(c.id, { color: e.target.value })} />
              </td>
              <td>
                <input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && patch(c.id, { name: e.target.value.trim() })} />
              </td>
              <td>
                <label className="inline">
                  <input type="checkbox" checked={c.is_business} onChange={(e) => patch(c.id, { is_business: e.target.checked })} />
                  Business
                </label>
              </td>
              <td><button className="link danger" onClick={() => remove(c.id, c.name)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="add-cat" onSubmit={add}>
        <input placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="inline">
          <input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} /> Business
        </label>
        <button>Add</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
