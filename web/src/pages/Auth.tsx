import { FormEvent, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Mode = "signin" | "signup" | "magic" | "forgot";

const TITLES: Record<Mode, string> = {
  signin: "Sign in",
  signup: "Create your account",
  magic: "Email me a sign-in link",
  forgot: "Reset your password",
};

/** Errors Supabase puts in the URL hash when a link is expired or already used. */
function linkErrorFromUrl(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const code = hash.get("error_code") ?? query.get("error_code");
  const desc = hash.get("error_description") ?? query.get("error_description");
  if (!code && !desc) return null;
  if (code === "otp_expired") return "That link has expired or was already used. Request a new one below.";
  return desc?.replace(/\+/g, " ") ?? "That link didn’t work. Try again.";
}

export default function Auth({ initialMode = "signin" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    const e = linkErrorFromUrl();
    if (e) {
      setError(e);
      history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const go = (m: Mode) => { setMode(m); setError(null); setSent(null); };
  const origin = window.location.origin;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const addr = email.trim();
    let err: { message: string } | null = null;

    if (mode === "signin") {
      ({ error: err } = await supabase.auth.signInWithPassword({ email: addr, password }));
      if (err?.message.toLowerCase().includes("email not confirmed")) {
        err = { message: "Confirm your email first — check your inbox for the link we sent when you signed up." };
      } else if (err?.message.toLowerCase().includes("invalid login")) {
        err = { message: "Wrong email or password. Try again, or reset your password." };
      }
    } else if (mode === "signup") {
      if (password.length < 8) err = { message: "Use at least 8 characters for your password." };
      else {
        const { data, error } = await supabase.auth.signUp({
          email: addr, password, options: { emailRedirectTo: `${origin}/welcome` },
        });
        err = error;
        // With email confirmation on, there's no session until the link is clicked.
        if (!error && !data.session) setSent(`We sent a confirmation link to ${addr}. Click it to finish creating your account.`);
      }
    } else if (mode === "magic") {
      ({ error: err } = await supabase.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: origin, shouldCreateUser: false } }));
      if (err?.message.toLowerCase().includes("signups not allowed")) err = { message: "No account with that email yet. Create one instead." };
      if (!err) setSent(`Check ${addr} for a sign-in link.`);
    } else {
      ({ error: err } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo: `${origin}/reset-password` }));
      // Don't reveal whether the address has an account.
      if (!err) setSent(`If ${addr} has an account, a reset link is on its way. It expires in an hour.`);
    }

    if (err) setError(err.message);
    setBusy(false);
  }

  return (
    <div className="center">
      <div className="auth">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">R</span>
          <span>Receipt Catcher</span>
        </div>
        <form className="card login" onSubmit={submit}>
          <h1>{TITLES[mode]}</h1>
          {mode === "signup" && <p className="muted small">Every receipt from your inbox, store accounts and paper photos, in one ledger.</p>}
          {mode === "forgot" && <p className="muted small">Enter your email and we’ll send you a link to choose a new password.</p>}

          {sent ? (
            <div className="sent">
              <p>{sent}</p>
              <p className="muted small">Didn’t get it? Check spam, or <button type="button" className="link" onClick={() => setSent(null)}>try again</button>.</p>
            </div>
          ) : (
            <>
              <label>Email
                <input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              {(mode === "signin" || mode === "signup") && (
                <label>
                  <span className="row-between">Password
                    {mode === "signin" && <button type="button" className="link small" onClick={() => go("forgot")}>Forgot password?</button>}
                  </span>
                  <input type="password" required minLength={mode === "signup" ? 8 : undefined}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "signup" ? "At least 8 characters" : undefined} />
                </label>
              )}
              <button className="primary" disabled={busy}>
                {busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : mode === "magic" ? "Send link" : "Send reset link"}
              </button>
            </>
          )}
          {error && <p className="error small" role="alert">{error}</p>}

          <div className="auth-switch">
            {mode === "signin" && <>
              <button type="button" className="link" onClick={() => go("magic")}>Email me a sign-in link instead</button>
              <span>New here? <button type="button" className="link" onClick={() => go("signup")}>Create an account</button></span>
            </>}
            {mode === "signup" && <span>Already have an account? <button type="button" className="link" onClick={() => go("signin")}>Sign in</button></span>}
            {(mode === "magic" || mode === "forgot") && <button type="button" className="link" onClick={() => go("signin")}>Back to sign in</button>}
          </div>
        </form>
      </div>
    </div>
  );
}
