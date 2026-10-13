import { FormEvent, useState } from "react";
import { supabase } from "../lib/supabase";
import { verifyCode } from "../lib/mfa";

/** Second sign-in step for people who turned on an authenticator app. */
export default function MfaChallenge({ email, onDone }: { email: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await verifyCode(code);
    setBusy(false);
    if (err) return setError(err);
    onDone();
  }

  return (
    <div className="center">
      <div className="auth">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">R</span>
          Receipt Catcher
        </div>
        <form className="card login" onSubmit={submit}>
          <h1>Enter your code</h1>
          <p className="muted small">Open your authenticator app and enter the 6-digit code for Receipt Catcher ({email}).</p>
          <label className="field">6-digit code
            <input className="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} autoFocus required
              value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          {error && <p className="error small" role="alert">{error}</p>}
          <button className="primary" disabled={busy || code.replace(/\s/g, "").length !== 6}>{busy ? "Checking…" : "Continue"}</button>
          <p className="muted small">
            Lost your phone? Use a backup device if you added one, or contact support to reset two-step sign-in.{" "}
            <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </p>
        </form>
      </div>
    </div>
  );
}
