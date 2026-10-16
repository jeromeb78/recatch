import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useConfirmIdentity } from "../components/ConfirmIdentity";
import { CheckIcon } from "../components/Icons";
import { allows, FULL, NONE, type Perms } from "../lib/permissions";

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp`;

// What Claude can do, by the access needed (owners have it all; team members get what the owner gave them).
const ACCESS: { text: string; area: "receipts" | "reports"; level: "view" | "edit" }[] = [
  { text: "See receipts, line items and spending totals", area: "receipts", level: "view" },
  { text: "Add receipts from pages and emails you share with it", area: "receipts", level: "edit" },
  { text: "Update a line item’s SKU, tax line, use or pack size", area: "receipts", level: "edit" },
  { text: "See profit, sales, Stripe and Easyship checks, and inventory costs by SKU", area: "reports", level: "view" },
  { text: "Set a SKU’s cost of goods", area: "reports", level: "edit" },
];

interface Choice { id: string; label: string; perms: Perms }

/** /oauth/authorize — Claude (or another MCP client) sends the user here to grant access. */
export default function OAuthConsent({ email }: { email: string }) {
  const confirmIdentity = useConfirmIdentity();
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const [client, setClient] = useState<{ client_name: string; redirect_uris: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [account, setAccount] = useState("");

  // Team members can connect Claude to an account they were invited to instead of their own.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("account_members").select("owner_id, owner_email, permissions").eq("member_id", user.id).order("owner_email");
      const shared = (data ?? []).map((m): Choice => ({
        id: m.owner_id, label: `${m.owner_email ?? "Another account"}’s account`, perms: { ...NONE, ...(m.permissions as Partial<Perms>) },
      })).filter((c) => allows(c.perms, "receipts") || allows(c.perms, "reports"));
      setChoices([{ id: user.id, label: "Your account", perms: FULL }, ...shared]);
      // Start with the account they were last working in.
      let last: string | null = null;
      try { last = localStorage.getItem(`recatch.account.${user.id}`); } catch { /* storage blocked */ }
      setAccount(shared.some((c) => c.id === last) ? last! : user.id);
    })();
  }, []);
  const chosen = choices.find((c) => c.id === account);

  useEffect(() => {
    if (params.get("response_type") !== "code" || !clientId || !redirectUri) {
      setError("This sign-in link is incomplete. Start connecting again from Claude.");
      return;
    }
    fetch(`${FN}/oauth/client?client_id=${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error_description ?? "Unknown app");
        if (!body.redirect_uris.includes(redirectUri)) throw new Error("This app’s return address doesn’t match its registration.");
        setClient(body);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(decision: "allow" | "deny") {
    if (decision === "allow" && !(await confirmIdentity(`Claude will be able to work with ${chosen && choices[0]?.id !== chosen.id ? chosen.label : "your account"}.`))) return;
    setBusy(true);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${FN}/oauth/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session?.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        decision,
        client_id: clientId,
        redirect_uri: redirectUri,
        state: params.get("state"),
        code_challenge: params.get("code_challenge"),
        code_challenge_method: params.get("code_challenge_method"),
        scope: params.get("scope"),
        account: account || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.redirect_to) {
      setBusy(false);
      return setError(body.error_description ?? body.error ?? "Something went wrong. Try connecting again.");
    }
    window.location.href = body.redirect_to;
  }

  const name = client?.client_name || "An app";
  const host = (() => { try { return new URL(redirectUri).host; } catch { return ""; } })();

  return (
    <div className="center narrow-center">
      <div className="card login consent">
        {error ? (
          <>
            <h1>Can’t connect</h1>
            <p className="error">{error}</p>
          </>
        ) : !client ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <h1>Allow {name} to access Receipt Catcher?</h1>
            <p className="muted small">Signed in as <b>{email}</b>. {name} will return to <b>{host}</b>.</p>
            {choices.length > 1 && (
              <label className="field">Connect to
                <select value={account} onChange={(e) => setAccount(e.target.value)}>
                  {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            )}
            <ul className="access-list">
              {ACCESS.filter((a) => !chosen || allows(chosen.perms, a.area, a.level)).map((a) => <li key={a.text}><CheckIcon size={16} />{a.text}</li>)}
            </ul>
            {chosen && choices[0]?.id !== chosen.id && (
              <p className="muted small">Uses your access to this account. If the owner removes you or changes your access, Claude follows it right away.</p>
            )}
            <p className="muted small">It can’t see your Gmail, passwords or store accounts. Disconnect any time in Settings → Claude.</p>
            <div className="welcome-actions">
              <button className="primary" disabled={busy || (choices.length > 0 && !chosen)} onClick={() => decide("allow")}>{busy ? "Connecting…" : "Allow"}</button>
              <button disabled={busy} onClick={() => decide("deny")}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
