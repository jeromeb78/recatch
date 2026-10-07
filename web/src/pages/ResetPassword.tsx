import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

/** Reached from the password-reset email; Supabase has already signed the user in for this purpose. */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don’t match.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    navigate("/", { replace: true, state: { notice: "Password updated." } });
  }

  return (
    <div className="center narrow-center">
      <form className="card login" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <label>New password
          <input type="password" autoComplete="new-password" required autoFocus value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </label>
        <label>Confirm password
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
        {error && <p className="error small" role="alert">{error}</p>}
      </form>
    </div>
  );
}
