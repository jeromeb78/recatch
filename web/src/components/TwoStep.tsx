import { FormEvent, useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { date } from "../lib/format";
import { verifiedFactors, type TotpFactor } from "../lib/mfa";
import { useConfirmIdentity } from "./ConfirmIdentity";

interface Enrolling { id: string; qr: string; secret: string }

/** supabase-js returns the QR as an unescaped SVG data URL; escape it so characters like "#" can't cut it short. */
function safeSvgUrl(qr: string): string {
  const raw = qr.replace(/^data:image\/svg\+xml;utf-8,/, "");
  return raw === qr ? qr : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

/** Turn on an authenticator app (TOTP) for this login, add a backup device, or turn it off. */
export function TwoStepSection({ onChange }: { onChange?: () => void }) {
  const confirmIdentity = useConfirmIdentity();
  const [factors, setFactors] = useState<TotpFactor[] | null>(null);
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => setFactors(await verifiedFactors()), []);
  useEffect(() => { load(); }, [load]);

  async function start() {
    setMsg(null);
    setBusy(true);
    // Clear a half-finished setup so the new one can use its name.
    const { data } = await supabase.auth.mfa.listFactors();
    for (const f of data?.all ?? []) {
      if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const n = (factors?.length ?? 0) + 1;
    const { data: enrolled, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: n === 1 ? "Authenticator app" : `Backup device ${n - 1} · ${new Date().toLocaleDateString()}`,
    });
    setBusy(false);
    if (error || !enrolled) return setMsg({ kind: "error", text: error?.message ?? "Couldn't start setup." });
    setEnrolling({ id: enrolled.id, qr: safeSvgUrl(enrolled.totp.qr_code), secret: enrolled.totp.secret });
    setCode("");
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.replace(/\s/g, "") });
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: "That code didn't match. Enter the newest code shown in the app." });
    setEnrolling(null);
    setMsg({ kind: "ok", text: "Two-step sign-in is on. You'll enter a code from the app each time you sign in." });
    await load();
    onChange?.();
  }

  async function cancel() {
    if (enrolling) await supabase.auth.mfa.unenroll({ factorId: enrolling.id });
    setEnrolling(null);
  }

  async function remove(f: TotpFactor) {
    const last = factors?.length === 1;
    if (!(await confirmIdentity(last ? "Turning off two-step sign-in makes your password the only thing protecting your receipts." : `Remove “${f.friendly_name ?? "device"}”?`))) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (error) return setMsg({ kind: "error", text: error.message });
    // Removing a factor can leave the session at a lower level; refresh it so data keeps loading.
    await supabase.auth.refreshSession();
    setMsg({ kind: "ok", text: last ? "Two-step sign-in is off." : "Device removed." });
    await load();
    onChange?.();
  }

  const on = !!factors?.length;
  return (
    <section className="card" id="two-step">
      <div className="row-between">
        <h2>Two-step sign-in</h2>
        {factors && <span className={`pill ${on ? "ok" : "warn"}`}>{on ? "On" : "Off"}</span>}
      </div>
      <p className="muted small">
        After your password, enter a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft
        Authenticator…). A stolen password alone then can't open your receipts — not in the app, the extension or Claude.
      </p>
      {on && (
        <ul className="member-list">
          {factors!.map((f) => (
            <li key={f.id} className="member row-between">
              <div className="grow"><b>{f.friendly_name ?? "Authenticator app"}</b><span className="muted small">Added {date(f.created_at)}</span></div>
              <button className="link danger" onClick={() => remove(f)}>{factors!.length === 1 ? "Turn off" : "Remove"}</button>
            </li>
          ))}
        </ul>
      )}
      {enrolling ? (
        <form className="stack-sm enroll" onSubmit={finish}>
          <ol className="small enroll-steps">
            <li>Open your authenticator app and add an account by scanning this code.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <img className="qr" src={enrolling.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <details className="small">
            <summary>Can't scan? Enter this key instead</summary>
            <code className="secret">{enrolling.secret}</code>
          </details>
          <label className="field">6-digit code
            <input className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="actions tight">
            <button className="primary" disabled={busy || code.replace(/\s/g, "").length !== 6}>{busy ? "Checking…" : "Turn on"}</button>
            <button type="button" className="link" onClick={cancel}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className={on ? "" : "primary"} disabled={busy || factors === null} onClick={start}>
            {on ? "Add a backup device" : "Set up two-step sign-in"}
          </button>
        </div>
      )}
      {on && !enrolling && <p className="muted small">Tip: add a second device (or save the key in a password manager) so losing your phone doesn't lock you out.</p>}
      {msg && <p className={msg.kind === "ok" ? "ok small" : "error small"} role="status">{msg.text}</p>}
    </section>
  );
}
