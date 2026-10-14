import { FormEvent, useState } from "react";
import { supabase } from "../lib/supabase";
import { accountId, useAccount } from "../lib/account";
import { ENTITY_FORM, ENTITY_LABEL, parseCards, parseStores, useBusinesses, type Business, type EntityType } from "../lib/businesses";

interface Draft { name: string; entity_type: EntityType; ein: string; description: string; cards: string; stores: string }
const EMPTY: Draft = { name: "", entity_type: "sole_prop", ein: "", description: "", cards: "", stores: "" };

const toDraft = (b: Business): Draft => ({
  name: b.name, entity_type: b.entity_type, ein: b.ein ?? "", description: b.description ?? "",
  cards: b.match_cards.join(", "), stores: b.match_merchants.join(", "),
});

function BusinessForm({ draft, setDraft, onSubmit, onCancel, busy, submitLabel }: {
  draft: Draft; setDraft: (d: Draft) => void; onSubmit: (e: FormEvent) => void; onCancel?: () => void; busy: boolean; submitLabel: string;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <form className="stack-sm biz-form" onSubmit={onSubmit}>
      <div className="row-wrap">
        <label className="field">Business name
          <input required maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="JTC Collectibles" />
        </label>
        <label className="field">Type
          <select value={draft.entity_type} onChange={(e) => set({ entity_type: e.target.value as EntityType })}>
            {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">EIN <span className="muted">(optional)</span>
          <input inputMode="numeric" pattern="[0-9]{2}-?[0-9]{7}" placeholder="12-3456789" value={draft.ein} onChange={(e) => set({ ein: e.target.value })} />
        </label>
      </div>
      <label className="field">What it sells or does
        <textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })}
          placeholder="Resells Hot Wheels and Matchbox die-cast cars on WooCommerce and eBay; buys shipping supplies." />
        <span className="muted small">Claude uses this to decide each item's expense category for this business.</span>
      </label>
      <div className="row-wrap">
        <label className="field">Cards used for it <span className="muted">(last 4)</span>
          <input value={draft.cards} onChange={(e) => set({ cards: e.target.value })} placeholder="4242, 1881" />
        </label>
        <label className="field">Stores that are always for it
          <input value={draft.stores} onChange={(e) => set({ stores: e.target.value })} placeholder="Uline, Pirate Ship" />
        </label>
      </div>
      <p className="muted small">New receipts paid with those cards or from those stores are assigned to this business automatically.</p>
      <div className="actions tight">
        <button className="primary" disabled={busy || !draft.name.trim()}>{busy ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** Settings → Businesses: add the businesses receipts can be allocated to. */
export function BusinessesSection() {
  const { can } = useAccount();
  const canEdit = can("settings", "edit");
  const { businesses, reload } = useBusinesses();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const values = (d: Draft) => ({
    name: d.name.trim(), entity_type: d.entity_type, ein: d.ein.trim() || null, description: d.description.trim() || null,
    match_cards: parseCards(d.cards), match_merchants: parseStores(d.stores),
  });

  async function applyRules(quiet = false) {
    const { data, error } = await supabase.rpc("apply_business_rules", { p_owner: accountId() });
    if (error) return setMsg({ kind: "error", text: error.message });
    if (!quiet || data) setMsg({ kind: "ok", text: `${data} receipt${data === 1 ? "" : "s"} assigned by card or store.` });
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const v = values(draft);
    const { error } = await supabase.from("businesses").insert({ user_id: accountId(), ...v });
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: error.code === "23505" ? "You already have a business with that name." : error.message });
    setAdding(false);
    setDraft(EMPTY);
    setMsg({ kind: "ok", text: `Added ${v.name}.` });
    await reload();
    if (v.match_cards.length || v.match_merchants.length) await applyRules(true);
  }

  async function save(e: FormEvent, b: Business) {
    e.preventDefault();
    setBusy(true);
    const v = values(draft);
    const { error } = await supabase.from("businesses").update(v).eq("id", b.id);
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: error.message });
    setEditing(null);
    setMsg({ kind: "ok", text: "Saved." });
    await reload();
  }

  async function assignAll(b: Business) {
    if (!confirm(`Assign every receipt that isn't assigned yet to ${b.name}? You can change single receipts afterwards.`)) return;
    const { error, count } = await supabase.from("receipts").update({ business_id: b.id }, { count: "exact" })
      .eq("user_id", accountId()).is("business_id", null);
    if (error) return setMsg({ kind: "error", text: error.message });
    setMsg({ kind: "ok", text: `${count ?? 0} receipts assigned to ${b.name}.` });
  }

  /** Re-runs Claude on this business's personal / low-confidence items using its description. */
  async function recheck(b: Business) {
    setBusy(true);
    let after: string | undefined, total = 0;
    try {
      for (let i = 0; i < 30; i++) {
        setMsg({ kind: "ok", text: `Re-checking ${b.name}'s items with Claude… ${total} done` });
        const { data, error } = await supabase.functions.invoke("categorize-items", {
          body: { recheck: true, limit: 100, after, business: b.id, account: accountId() },
        });
        if (error) {
          const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
          throw new Error(detail?.error ?? error.message);
        }
        total += data.categorized;
        if (!data.next) break;
        after = data.next;
      }
      setMsg({ kind: "ok", text: `Re-checked ${total} item${total === 1 ? "" : "s"} for ${b.name}. See Reports → Write-offs.` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function archive(b: Business, on: boolean) {
    await supabase.from("businesses").update({ archived_at: on ? new Date().toISOString() : null }).eq("id", b.id);
    reload();
  }

  async function remove(b: Business) {
    if (!confirm(`Delete ${b.name}? Its receipts and items stay, but become unassigned. (Archive keeps them assigned.)`)) return;
    const { error } = await supabase.from("businesses").delete().eq("id", b.id);
    if (error) return setMsg({ kind: "error", text: error.message });
    reload();
  }

  return (
    <section className="card" id="businesses">
      <h2>Businesses</h2>
      <p className="muted small">
        Run more than one business? Add each one, then every receipt (or single item) can be allocated to the right business.
        Write-offs, mileage and exports are worked out per business — each sole proprietorship files its own Schedule C.
      </p>
      {businesses === null ? <p className="muted">Loading…</p> : (
        <ul className="member-list">
          {businesses.map((b) => (
            <li key={b.id} className={`member${b.archived_at ? " muted" : ""}`}>
              {editing === b.id ? (
                <BusinessForm draft={draft} setDraft={setDraft} busy={busy} submitLabel="Save" onSubmit={(e) => save(e, b)} onCancel={() => setEditing(null)} />
              ) : (
                <div className="row-between">
                  <div className="grow">
                    <b>{b.name}</b>{b.archived_at && <span className="pill">archived</span>}
                    <span className="muted small">
                      {ENTITY_LABEL[b.entity_type]}{ENTITY_FORM[b.entity_type] ? ` · ${ENTITY_FORM[b.entity_type]}` : ""}
                      {b.ein ? ` · EIN ••-•••${b.ein.replace(/\D/g, "").slice(-4)}` : ""}
                    </span>
                    {(b.match_cards.length > 0 || b.match_merchants.length > 0) && (
                      <span className="muted small">
                        Auto: {[...b.match_cards.map((c) => `card •${c}`), ...b.match_merchants].join(", ")}
                      </span>
                    )}
                    {!b.description && !b.archived_at && <span className="warn-text small">Add what it sells so items are categorized correctly.</span>}
                  </div>
                  {canEdit && (
                    <div className="actions tight">
                      <button className="btn sm" onClick={() => { setEditing(b.id); setDraft(toDraft(b)); }}>Edit</button>
                      <details className="more">
                        <summary className="btn sm" aria-label={`More for ${b.name}`}>⋯</summary>
                        <div className="menu">
                          <button className="link" disabled={busy} onClick={() => recheck(b)}>Re-check expense categories with Claude</button>
                          <button className="link" onClick={() => assignAll(b)}>Assign all unassigned receipts here</button>
                          <button className="link" onClick={() => archive(b, !b.archived_at)}>{b.archived_at ? "Unarchive" : "Archive (closed business)"}</button>
                          <button className="link danger" onClick={() => remove(b)}>Delete</button>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
          {businesses.length === 0 && <li className="muted small">No businesses yet — everything is treated as one business.</li>}
        </ul>
      )}
      {msg && <p className={msg.kind === "ok" ? "ok small" : "error small"} role="status">{msg.text}</p>}
      {canEdit && (adding ? (
        <BusinessForm draft={draft} setDraft={setDraft} busy={busy} submitLabel="Add business" onSubmit={add} onCancel={() => setAdding(false)} />
      ) : (
        <div className="actions">
          <button className={businesses?.length ? "" : "primary"} onClick={() => { setAdding(true); setDraft(EMPTY); }}>Add a business</button>
          {!!businesses?.some((b) => b.match_cards.length || b.match_merchants.length) && (
            <button className="link" onClick={() => applyRules()}>Apply card/store rules to unassigned receipts</button>
          )}
        </div>
      ))}
    </section>
  );
}
