import { FormEvent, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setError(error.message);
      setState("idle");
    } else {
      setState("sent");
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>🧾 Receipt Catcher</h1>
        <p className="muted">Every receipt from your inbox, forwarded mail and paper photos, in one ledger.</p>
        {state === "sent" ? (
          <p>Check <strong>{email}</strong> for a sign-in link.</p>
        ) : (
          <>
            <label>
              Email
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="primary" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Send magic link"}
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
      </form>
    </div>
  );
}
