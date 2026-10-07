import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { CheckIcon } from "../components/Icons";

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp`;

const ACCESS = [
  "See your receipts, line items and spending totals",
  "See inventory costs by Woo SKU",
  "Add receipts from pages and emails you share with it",
  "Update a line item’s SKU, tax line, use or pack size",
];

/** /oauth/authorize — Claude (or another MCP client) sends the user here to grant access. */
export default function OAuthConsent({ email }: { email: string }) {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const [client, setClient] = useState<{ client_name: string; redirect_uris: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
            <ul className="access-list">
              {ACCESS.map((a) => <li key={a}><CheckIcon size={16} />{a}</li>)}
            </ul>
            <p className="muted small">It can’t see your Gmail, passwords or store accounts. Disconnect any time in Settings → Claude.</p>
            <div className="welcome-actions">
              <button className="primary" disabled={busy} onClick={() => decide("allow")}>{busy ? "Connecting…" : "Allow"}</button>
              <button disabled={busy} onClick={() => decide("deny")}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
