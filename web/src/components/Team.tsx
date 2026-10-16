import { FormEvent, useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { date } from "../lib/format";
import { useConfirmIdentity } from "./ConfirmIdentity";
import {
  AREAS, describePerms, LEVEL_LABEL, presetFor, PRESETS, useAccount, type Area, type Level, type Perms,
} from "../lib/account";

interface Member { member_id: string; member_email: string; permissions: Perms; created_at: string }
interface Invite { id: string; email: string; permissions: Perms; expires_at: string; created_at: string }

const presetLabel = (p: Perms) => PRESETS.find((x) => x.key === presetFor(p))?.label ?? "Custom";

/** Per-area access pickers. `lockTeam` hides team management from people who aren't the owner. */
function PermPicker({ value, onChange, lockTeam, disabled }: { value: Perms; onChange: (p: Perms) => void; lockTeam: boolean; disabled?: boolean }) {
  return (
    <div className="perm-grid">
      {AREAS.map((a) => (
        <label key={a.key} className="field" title={a.help}>
          {a.label}
          <select value={value[a.key]} disabled={disabled || (a.key === "team" && lockTeam)}
            onChange={(e) => onChange({ ...value, [a.key]: e.target.value as Level })}>
            {a.levels.map((l) => <option key={l} value={l}>{a.key === "team" && l === "edit" ? "Can manage" : LEVEL_LABEL[l]}</option>)}
          </select>
          <span className="muted small">{a.help}</span>
        </label>
      ))}
    </div>
  );
}

function PresetPicker({ value, onChange, lockTeam }: { value: Perms; onChange: (p: Perms) => void; lockTeam: boolean }) {
  const current = presetFor(value);
  return (
    <div className="preset-row" role="radiogroup" aria-label="Access level">
      {PRESETS.filter((p) => !(lockTeam && p.perms.team === "edit")).map((p) => (
        <button type="button" key={p.key} role="radio" aria-checked={current === p.key}
          className={`preset ${current === p.key ? "on" : ""}`} onClick={() => onChange(p.perms)}>
          <b>{p.label}</b>
          <span className="muted small">{p.help}</span>
        </button>
      ))}
      <span className={`preset custom ${current === "custom" ? "on" : ""}`} aria-hidden={current !== "custom"}>
        <b>Custom</b>
        <span className="muted small">Pick per area below</span>
      </span>
    </div>
  );
}

export function TeamSection({ userId }: { userId: string }) {
  const { account } = useAccount();
  const owner = account.ownerId;
  const isOwner = account.own;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Perms>(PRESETS[0].perms);
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<Perms>(PRESETS[0].perms);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [requireMfa, setRequireMfa] = useState(false);
  const confirmIdentity = useConfirmIdentity();

  useEffect(() => {
    if (!isOwner) return;
    supabase.from("profiles").select("require_team_mfa").eq("user_id", owner).maybeSingle()
      .then(({ data }) => setRequireMfa(!!data?.require_team_mfa));
  }, [isOwner, owner]);

  async function toggleRequireMfa(on: boolean) {
    if (on && !confirm("Everyone on your team will need two-step sign-in. Anyone who hasn't set it up loses access until they do. Continue?")) return;
    if (!on && !(await confirmIdentity("Team members will be able to open your receipts with just their password."))) return;
    const { error } = await supabase.from("profiles").update({ require_team_mfa: on }).eq("user_id", owner);
    if (error) return setMsg({ kind: "error", text: error.message });
    setRequireMfa(on);
  }

  const load = useCallback(async () => {
    const [m, i] = await Promise.all([
      supabase.from("account_members").select("member_id, member_email, permissions, created_at").eq("owner_id", owner).order("created_at"),
      supabase.from("account_invites").select("id, email, permissions, expires_at, created_at").eq("owner_id", owner)
        .is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
    ]);
    if (m.error) setMsg({ kind: "error", text: m.error.message });
    setMembers((m.data ?? []) as Member[]);
    setInvites((i.data ?? []) as Invite[]);
  }, [owner]);

  useEffect(() => { load(); }, [load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (perms.team === "edit" && !(await confirmIdentity(`${email.trim()} will be able to invite people and change everyone's access.`))) return;
    setBusy(true);
    setMsg(null);
    setLink(null);
    const { data, error } = await supabase.rpc("create_invite", { p_owner: owner, p_email: email.trim(), p_permissions: perms });
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: error.message });
    setLink({ email: email.trim().toLowerCase(), url: `${window.location.origin}/invite?token=${data as string}` });
    setEmail("");
    load();
  }

  async function saveMember(m: Member) {
    if (draft.team === "edit" && m.permissions.team !== "edit" && !(await confirmIdentity(`${m.member_email} will be able to invite people and change everyone's access.`))) return;
    setBusy(true);
    const { error } = await supabase.from("account_members").update({ permissions: draft }).eq("owner_id", owner).eq("member_id", m.member_id);
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: error.message });
    setMsg({ kind: "ok", text: `Updated ${m.member_email}. It applies the next time they load the app.` });
    setEditing(null);
    load();
  }

  async function removeMember(m: Member) {
    if (!confirm(`Remove ${m.member_email}? They lose access to this account right away.`)) return;
    const { error } = await supabase.from("account_members").delete().eq("owner_id", owner).eq("member_id", m.member_id);
    if (error) return setMsg({ kind: "error", text: error.message });
    setMsg({ kind: "ok", text: `Removed ${m.member_email}.` });
    load();
  }

  async function revoke(i: Invite) {
    const { error } = await supabase.from("account_invites").update({ revoked_at: new Date().toISOString() }).eq("id", i.id);
    if (error) return setMsg({ kind: "error", text: error.message });
    if (link?.email === i.email) setLink(null);
    load();
  }

  const mailto = link && `mailto:${encodeURIComponent(link.email)}?subject=${encodeURIComponent("Join my Receipt Catcher account")}&body=${
    encodeURIComponent(`I've invited you to my Receipt Catcher account. Open this link and sign up or sign in with ${link.email}:\n\n${link.url}\n\nThe link works once and expires in 7 days.`)}`;

  return (
    <section className="card team" id="team">
      <h2>Team</h2>
      <p className="muted small">
        Invite a bookkeeper, assistant or accountant and choose what they can see or change. They use their own login and
        work in this account's receipts. They can also install the phone app, the browser extension and the Claude connector
        for this account (in their Settings) — each works only within the access you give them, and removing someone cuts
        off all of their connections right away. Gmail and the forwarding address stay with the owner.
      </p>

      <ul className="member-list">
        <li className="member">
          <div className="grow">
            <b>{account.ownerEmail}</b>
            <span className="muted small">Owner · full access</span>
          </div>
        </li>
        {members === null && <li className="muted">Loading…</li>}
        {members?.map((m) => {
          const self = m.member_id === userId;
          // Only the owner can change or remove someone who manages the team.
          const locked = self || (!isOwner && m.permissions.team === "edit");
          return (
            <li key={m.member_id} className="member">
              <div className="row-between">
                <div className="grow">
                  <b>{m.member_email}</b>{self && <span className="pill">you</span>}
                  <span className="muted small">{presetLabel(m.permissions)} · {describePerms(m.permissions)} · since {date(m.created_at)}</span>
                </div>
                {!locked && editing !== m.member_id && (
                  <div className="actions tight">
                    <button className="btn sm" onClick={() => { setEditing(m.member_id); setDraft(m.permissions); }}>Change access</button>
                    <button className="link danger" onClick={() => removeMember(m)}>Remove</button>
                  </div>
                )}
              </div>
              {editing === m.member_id && (
                <div className="stack-sm member-edit">
                  <PresetPicker value={draft} onChange={setDraft} lockTeam={!isOwner} />
                  <PermPicker value={draft} onChange={setDraft} lockTeam={!isOwner} />
                  <div className="actions tight">
                    <button className="primary" disabled={busy} onClick={() => saveMember(m)}>Save access</button>
                    <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {invites.map((i) => (
          <li key={i.id} className="member pending">
            <div className="row-between">
              <div className="grow">
                <b>{i.email}</b><span className="pill warn">invited</span>
                <span className="muted small">{presetLabel(i.permissions)} · {describePerms(i.permissions)} · link expires {date(i.expires_at)}</span>
              </div>
              <button className="link danger" onClick={() => revoke(i)}>Cancel invite</button>
            </div>
          </li>
        ))}
      </ul>

      {isOwner && (
        <label className="inline require-mfa">
          <input type="checkbox" checked={requireMfa} onChange={(e) => toggleRequireMfa(e.target.checked)} />
          <span>Require two-step sign-in for everyone on this team <span className="muted small">— recommended when people can see your receipts</span></span>
        </label>
      )}

      {msg && <p className={msg.kind === "ok" ? "ok small" : "error small"} role="status">{msg.text}</p>}

      {link && (
        <div className="banner ok invite-link">
          <b>Invite ready for {link.email}.</b> Send them this link — it works once and expires in 7 days.
          <div className="copy">
            <code>{link.url}</code>
            <button onClick={async () => {
              await navigator.clipboard.writeText(link.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <a className="btn sm" href={mailto!}>Email it</a>
        </div>
      )}

      <form className="stack-sm invite-form" onSubmit={invite}>
        <h3>Invite someone</h3>
        <label className="field">Email
          <input type="email" required autoComplete="off" placeholder="bookkeeper@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <PresetPicker value={perms} onChange={setPerms} lockTeam={!isOwner} />
        <details open={presetFor(perms) === "custom"}>
          <summary className="small">Fine-tune what they can view or edit</summary>
          <PermPicker value={perms} onChange={setPerms} lockTeam={!isOwner} />
        </details>
        <div className="actions tight">
          <button className="primary" disabled={busy || !email.trim()}>{busy ? "Creating…" : "Create invite link"}</button>
        </div>
      </form>
    </section>
  );
}

/** For someone working in another person's account: what they can do, and a way out. */
export function MembershipSection({ userId }: { userId: string }) {
  const { account, switchTo } = useAccount();
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    if (!confirm(`Leave ${account.ownerEmail}'s account? You'll need a new invite to get back in.`)) return;
    const { error } = await supabase.from("account_members").delete().eq("owner_id", account.ownerId).eq("member_id", userId);
    if (error) return setError(error.message);
    switchTo(userId);
  }

  return (
    <section className="card">
      <h2>Your access</h2>
      <p className="muted small">You're a member of <b>{account.ownerEmail}</b>'s account. Only they (or a team manager) can change this.</p>
      <ul className="perm-list">
        {AREAS.map((a) => (
          <li key={a.key} className={account.perms[a.key as Area] === "none" ? "muted" : ""}>
            <b>{a.label}</b>: {a.key === "team" && account.perms.team === "edit" ? "Can manage" : LEVEL_LABEL[account.perms[a.key as Area]]}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button onClick={() => switchTo(userId)}>Switch to my own account</button>
        <button className="link danger" onClick={leave}>Leave this account</button>
      </div>
    </section>
  );
}
