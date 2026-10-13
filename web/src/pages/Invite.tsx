import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { AREAS, LEVEL_LABEL, PENDING_INVITE_KEY, rememberAccount, type Perms } from "../lib/account";

type Info = { owner_email: string; email: string; permissions: Perms; status: "pending" | "accepted" | "revoked" | "expired" };

function pendingToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

function setPending(token: string | null) {
  try {
    if (token) localStorage.setItem(PENDING_INVITE_KEY, token);
    else localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // ignore
  }
}

/** Opened from an invite link. Works signed out (shows the invite, then sign up / sign in) and signed in (accept). */
export default function Invite({ userId, email }: { userId?: string; email?: string }) {
  const [token] = useState(pendingToken);
  const [info, setInfo] = useState<Info | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setInfo(null);
      return;
    }
    supabase.rpc("invite_info", { p_token: token }).then(({ data }) => {
      const row = (Array.isArray(data) ? data[0] : data) as Info | undefined;
      setInfo(row ?? null);
      // Keep it through sign-up / email confirmation, but not once it can't be used.
      setPending(row?.status === "pending" ? token : null);
    });
  }, [token]);

  function done(to = "/") {
    setPending(null);
    window.location.assign(to);
  }

  async function accept() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("accept_invite", { p_token: token });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    rememberAccount(userId!, data as string);
    done();
  }

  const wrongEmail = !!(userId && info && email && info.email.toLowerCase() !== email.toLowerCase());

  return (
    <div className="center">
      <div className="auth">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">R</span>
          Receipt Catcher
        </div>
        <div className="card invite-card">
          {info === undefined && <p className="muted">Loading invite…</p>}
          {info === null && (
            <>
              <h2>Invite not found</h2>
              <p className="muted">This link is incomplete or was replaced by a newer invite. Ask for a new link.</p>
              <button onClick={() => done()}>Continue</button>
            </>
          )}
          {info && info.status !== "pending" && (
            <>
              <h2>
                {info.status === "accepted" ? "Invite already used" : info.status === "revoked" ? "Invite cancelled" : "Invite expired"}
              </h2>
              <p className="muted">
                {info.status === "accepted"
                  ? `It's been accepted. Sign in as ${info.email} and pick ${info.owner_email}'s account from the account switcher.`
                  : `Ask ${info.owner_email} to send you a new invite.`}
              </p>
              <button onClick={() => done()}>Continue</button>
            </>
          )}
          {info && info.status === "pending" && (
            <>
              <h2>{info.owner_email} invited you</h2>
              <p>Join their Receipt Catcher account as <b>{info.email}</b>. You'll be able to:</p>
              <ul className="perm-list">
                {AREAS.map((a) => (
                  <li key={a.key} className={info.permissions[a.key] === "none" ? "muted" : ""}>
                    <b>{a.label}</b>: {LEVEL_LABEL[info.permissions[a.key] ?? "none"]}
                  </li>
                ))}
              </ul>
              {error && <p className="error" role="alert">{error}</p>}
              {!userId && (
                <>
                  <p className="muted">Create an account or sign in with {info.email} to accept.</p>
                  <div className="actions">
                    <a className="btn primary" href="/signup">Create account</a>
                    <a className="btn" href="/">Sign in</a>
                  </div>
                </>
              )}
              {userId && wrongEmail && (
                <>
                  <p className="banner warn">
                    You're signed in as {email}, but this invite is for {info.email}. Sign out and sign in (or create an account) with {info.email}.
                  </p>
                  <div className="actions">
                    <button className="primary" onClick={() => supabase.auth.signOut()}>Sign out</button>
                    <button className="link" onClick={() => done()}>Not now</button>
                  </div>
                </>
              )}
              {userId && !wrongEmail && (
                <div className="actions">
                  <button className="primary" onClick={accept} disabled={busy}>{busy ? "Joining…" : "Accept invite"}</button>
                  <button className="link" onClick={() => done()}>Decline</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
