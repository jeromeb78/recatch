import { createContext, FormEvent, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { verifiedFactors, verifyCode } from "../lib/mfa";

type Ask = (reason: string) => Promise<boolean>;
const ConfirmContext = createContext<Ask>(async () => false);

/**
 * Before sensitive actions (changing email, connecting Gmail or Claude, making an extension code, giving
 * someone team management, turning off two-step sign-in) ask for the 6-digit code — or the password
 * for people without two-step sign-in — so a computer left signed in can't be used for them.
 */
export function useConfirmIdentity(): Ask {
  return useContext(ConfirmContext);
}

export function ConfirmIdentityProvider({ email, children }: { email: string; children: ReactNode }) {
  const [reason, setReason] = useState<string | null>(null);
  const [mode, setMode] = useState<"code" | "password">("password");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>(async (why) => {
    const factors = await verifiedFactors();
    setMode(factors.length ? "code" : "password");
    setValue("");
    setError(null);
    setReason(why);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  function close(ok: boolean) {
    setReason(null);
    resolver.current?.(ok);
    resolver.current = null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let err: string | null;
    if (mode === "code") {
      err = await verifyCode(value);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password: value });
      err = error
        ? "That password didn't work. If you've only ever signed in with email links, set a password under Settings → Account first."
        : null;
    }
    setBusy(false);
    if (err) return setError(err);
    close(true);
  }

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {reason && (
        <div className="modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <form className="card modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onSubmit={submit}>
            <h2 id="confirm-title">Confirm it's you</h2>
            <p className="muted small">{reason}</p>
            {mode === "code" ? (
              <label className="field">6-digit code from your authenticator app
                <input className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus required
                  value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            ) : (
              <label className="field">Password for {email}
                <input type="password" autoComplete="current-password" autoFocus required value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            )}
            {error && <p className="error small" role="alert">{error}</p>}
            <div className="actions">
              <button className="primary" disabled={busy || !value}>{busy ? "Checking…" : "Confirm"}</button>
              <button type="button" className="link" onClick={() => close(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
