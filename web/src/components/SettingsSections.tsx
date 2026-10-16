import { FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { relative } from "../lib/format";
import { useConfirmIdentity } from "./ConfirmIdentity";

/* ---------------- Business profile ---------------- */

export function BusinessProfile({ userId, readOnly = false }: { userId: string; readOnly?: boolean }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("profiles").select("business_description").eq("user_id", userId).maybeSingle()
      .then(({ data }) => setText(data?.business_description ?? ""));
  }, [userId]);

  async function save() {
    if (readOnly) return;
    const { error } = await supabase.from("profiles").update({ business_description: text.trim() || null }).eq("user_id", userId);
    setSaved(error ? error.message : "Saved");
    setTimeout(() => setSaved(null), 1500);
  }

  return (
    <section className="card">
      <div className="row-between"><h2>{readOnly ? "The business" : "Your business"}</h2>{saved && <span className="ok small">{saved}</span>}</div>
      <p className="muted small">
        One or two sentences about what you sell and buy. Claude uses this to decide what counts as inventory or a business
        expense when it categorizes items for taxes.
      </p>
      <textarea rows={3} className="full-width" readOnly={readOnly} value={text} onChange={(e) => setText(e.target.value)} onBlur={save}
        aria-label="Business description"
        placeholder="e.g. I resell die-cast cars (Hot Wheels, Matchbox) on my WooCommerce store and eBay. I buy inventory at Walmart and Target and ship with Pirate Ship." />
    </section>
  );
}

/* ---------------- Browser extension ---------------- */

interface Token { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null; account_id: string | null }

/** Connections made by `userId` for `account` (their own account when they match). */
export const forAccount = <T extends { account_id: string | null }>(rows: T[], userId: string, account: string) =>
  rows.filter((r) => (r.account_id ?? userId) === account);

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "rc_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Browser extension codes. `account` is the account receipts go to: your own, or (for a team member) the account you're
 * working in; the code stops working if the owner removes you or takes away your access to add receipts.
 */
export function ExtensionSection({ userId, account = userId, ownerEmail, compact = false }: { userId: string; account?: string; ownerEmail?: string; compact?: boolean }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmIdentity = useConfirmIdentity();

  const load = useCallback(async () => {
    const { data } = await supabase.from("api_tokens").select("id, name, created_at, last_used_at, revoked_at, account_id")
      .eq("user_id", userId).is("revoked_at", null).order("created_at", { ascending: false });
    setTokens(forAccount((data ?? []) as Token[], userId, account));
  }, [userId, account]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setError(null);
    if (!(await confirmIdentity(`A connection code lets the browser extension add receipts to ${ownerEmail ? `${ownerEmail}'s` : "your"} account.`))) return;
    const token = randomToken();
    const { error } = await supabase.from("api_tokens").insert({
      user_id: userId,
      account_id: account === userId ? null : account,
      name: `Browser extension · ${new Date().toLocaleDateString()}`,
      token_hash: await sha256Hex(token),
    });
    if (error) return setError(error.message);
    const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest-page`;
    setCode(btoa(JSON.stringify({ u: endpoint, t: token })));
    load();
  }

  async function revoke(id: string) {
    if (!confirm("Disconnect this extension? It will stop being able to send receipts.")) return;
    await supabase.from("api_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    load();
  }

  return (
    <section className="card">
      {!compact && <>
        <h2>Browser extension</h2>
        <p className="muted small">
          Import order history from Walmart, Target and Amazon in bulk using your own signed-in browser. Install the Receipt
          Catcher extension (desktop Chrome or Edge), then paste a connection code into it.
          {ownerEmail && <> Codes you make here add receipts to <b>{ownerEmail}</b>'s account.</>}
        </p>
      </>}
      <InstallExtension />
      {code ? (
        <div className="stack-sm">
          <div className="copy">
            <code className="code-block">{code}</code>
            <button onClick={async () => { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="warn-text small">Shown once. Paste it into the extension now; anyone with this code can add receipts to {ownerEmail ? `${ownerEmail}'s` : "your"} account.</p>
          <button className="link" onClick={() => setCode(null)}>Done</button>
        </div>
      ) : (
        <button className="primary" onClick={create}>2 · Create connection code</button>
      )}
      {error && <p className="error">{error}</p>}
      {tokens.length > 0 && (
        <div className="token-list">
          {tokens.map((t) => (
            <div key={t.id} className="conn">
              <div>
                <strong>{t.name}</strong>
                <div className="muted small">Last used {relative(t.last_used_at)}</div>
              </div>
              <button className="link danger" onClick={() => revoke(t.id)}>Disconnect</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- Account ---------------- */

export function AccountSection({ email }: { email: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const confirmIdentity = useConfirmIdentity();

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setMsg({ kind: "error", text: "Use at least 8 characters." });
    const { error } = await supabase.auth.updateUser({ password });
    setMsg(error ? { kind: "error", text: error.message } : { kind: "ok", text: "Password updated." });
    if (!error) setPassword("");
  }

  async function changeEmail(e: FormEvent) {
    e.preventDefault();
    if (!(await confirmIdentity(`Your sign-in email will change to ${newEmail.trim()}.`))) return;
    const { error } = await supabase.auth.updateUser(
      { email: newEmail.trim() },
      { emailRedirectTo: `${window.location.origin}/settings` },
    );
    setMsg(error ? { kind: "error", text: error.message }
      : { kind: "ok", text: `Check ${newEmail.trim()} (and your current inbox) to confirm the change.` });
    if (!error) setNewEmail("");
  }

  return (
    <section className="card">
      <h2>Account</h2>
      <p className="muted small">Signed in as <b>{email}</b></p>
      <form className="row-wrap" onSubmit={changePassword}>
        <label className="field">New password
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </label>
        <button disabled={!password}>Set password</button>
      </form>
      <form className="row-wrap" onSubmit={changeEmail}>
        <label className="field">New email
          <input type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
        </label>
        <button disabled={!newEmail}>Change email</button>
      </form>
      {msg && <p className={msg.kind === "ok" ? "ok small" : "error small"}>{msg.text}</p>}
      <div className="actions">
        <button onClick={() => navigate("/welcome")}>Re-run setup guide</button>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        <button onClick={() => supabase.auth.signOut({ scope: "global" })} className="link">Sign out everywhere</button>
      </div>
    </section>
  );
}

/* ---------------- Extension install ---------------- */

const STORE_URL = (import.meta.env.VITE_EXTENSION_STORE_URL as string | undefined) || "";

function InstallExtension() {
  return (
    <div className="install">
      {STORE_URL ? (
        <a className="btn" href={STORE_URL} target="_blank" rel="noreferrer">1 · Add to Chrome</a>
      ) : (
        <a className="btn" href="/receipt-catcher-extension.zip" download>1 · Download extension (.zip)</a>
      )}
      <details>
        <summary className="small">{STORE_URL ? "Install from a file instead" : "How to install the .zip"}</summary>
        <ol className="small muted">
          {STORE_URL && <li><a href="/receipt-catcher-extension.zip" download>Download the .zip</a></li>}
          <li>Unzip it into a folder you’ll keep (Chrome loads it from there).</li>
          <li>Open <code>chrome://extensions</code> (or <code>edge://extensions</code>) and turn on <b>Developer mode</b>.</li>
          <li>Click <b>Load unpacked</b> and choose the unzipped folder, then pin Receipt Catcher from the puzzle-piece menu.</li>
          <li>Click its icon and paste the connection code from step 2.</li>
        </ol>
      </details>
    </div>
  );
}

/* ---------------- Claude connector ---------------- */

interface Grant { id: string; client_id: string; account_id: string | null; created_at: string; last_used_at: string | null; client: { client_name: string } | null }

const IMPORT_PROMPT = `Use Receipt Catcher to import my order history. Open my Walmart purchase history (walmart.com → Account → Purchase history). Collect the order links for the last 12 months, call check_imported to skip ones already in Receipt Catcher, then open each new order one at a time and call add_receipt with the page's full text and URL. Don't change, cancel or reorder anything. If a sign-in or CAPTCHA appears, stop and ask me. Finish with how many were added.`;

/** The Claude connector. Team members connect it to the account they're working in and get only the access they have there. */
export function ClaudeSection({ userId, account = userId, ownerEmail }: { userId?: string; account?: string; ownerEmail?: string } = {}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const url = `${window.location.origin}/mcp`;

  const load = useCallback(async () => {
    const { data } = await supabase.from("oauth_tokens")
      .select("id, client_id, account_id, created_at, last_used_at, client:oauth_clients(client_name)")
      .is("revoked_at", null).order("created_at", { ascending: false });
    // One row per connected app (refreshes create new token rows), for the account shown.
    const seen = new Set<string>();
    const rows = (data ?? []) as unknown as Grant[];
    setGrants((userId ? forAccount(rows, userId, account!) : rows).filter((g) => !seen.has(g.client_id) && seen.add(g.client_id)));
  }, [userId, account]);
  useEffect(() => { load(); }, [load]);

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  async function disconnect(g: Grant) {
    if (!confirm(`Disconnect ${g.client?.client_name ?? "this app"}? It will lose access to Receipt Catcher right away.`)) return;
    const q = supabase.from("oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("client_id", g.client_id).is("revoked_at", null);
    await (g.account_id ? q.eq("account_id", g.account_id) : q.is("account_id", null));
    load();
  }

  return (
    <section className="card">
      <h2>Claude</h2>
      <p className="muted small">
        Connect Receipt Catcher to Claude to ask about your spending and inventory costs, add receipts from chat, and — with
        Claude in Chrome — import store order history in your own browser.
        {ownerEmail && <> Connected to <b>{ownerEmail}</b>'s account, Claude can do what your access allows there: see or add
          receipts, and see profit and costs.</>}
      </p>
      <div className="copy">
        <code>{url}</code>
        <button onClick={() => copy(url, "url")}>{copied === "url" ? "Copied" : "Copy"}</button>
      </div>
      <ol className="small muted steps-plain">
        <li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
        <li>Name it “Receipt Catcher”, paste the URL above, and click <b>Add</b>, then <b>Connect</b>.</li>
        <li>Sign in here if asked{ownerEmail ? <>, choose <b>{ownerEmail}</b>'s account,</> : ""} and click <b>Allow</b>.</li>
      </ol>
      <details>
        <summary className="small">Prompt for importing order history with Claude in Chrome</summary>
        <p className="small muted prompt-text">{IMPORT_PROMPT}</p>
        <button className="btn sm" onClick={() => copy(IMPORT_PROMPT, "prompt")}>{copied === "prompt" ? "Copied" : "Copy prompt"}</button>
      </details>
      {grants.length > 0 && (
        <div className="token-list">
          {grants.map((g) => (
            <div key={g.client_id} className="conn">
              <div>
                <strong>{g.client?.client_name ?? "Connected app"}</strong>
                <div className="muted small">Connected {new Date(g.created_at).toLocaleDateString()} · last used {relative(g.last_used_at)}</div>
              </div>
              <button className="link danger" onClick={() => disconnect(g)}>Disconnect</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
