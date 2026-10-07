import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { CameraIcon, CheckIcon } from "../components/Icons";
import { ExtensionSection } from "../components/SettingsSections";

const STEPS = ["Your business", "Gmail", "Forwarding", "Store history", "First receipt"];
const INBOUND = (import.meta.env.VITE_INBOUND_ADDRESS as string | undefined) ?? "";

export default function Welcome({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const step = Math.min(Math.max(Number(params.get("step")) || 0, 0), STEPS.length - 1);
  const go = (n: number) => setParams({ step: String(n) }, { replace: true });

  const [business, setBusiness] = useState("");
  const [gmail, setGmail] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("profiles").select("business_description, inbound_token").eq("user_id", userId).maybeSingle()
      .then(({ data }) => {
        setBusiness(data?.business_description ?? "");
        setToken(data?.inbound_token ?? null);
      });
    supabase.from("email_connections").select("email").then(({ data }) => setGmail((data ?? []).map((c) => c.email)));
    // Back from Google's consent screen.
    if (params.get("gmail") === "error") setError(`Gmail connection failed (${params.get("reason") ?? "unknown"}). You can try again or skip.`);
  }, [userId, params]);

  async function saveBusiness() {
    await supabase.from("profiles").update({ business_description: business.trim() || null }).eq("user_id", userId);
    go(1);
  }

  async function connectGmail() {
    const { data, error } = await supabase.functions.invoke("gmail-oauth", { method: "POST", body: { return_to: "/welcome?step=2" } });
    if (error) return setError("Couldn’t start the Gmail connection. You can do this later in Settings.");
    window.location.href = data.url;
  }

  async function finish(to: string) {
    await supabase.from("profiles").update({ onboarded_at: new Date().toISOString() }).eq("user_id", userId);
    navigate(to, { replace: true });
  }

  const [local, domain] = INBOUND.split("@");
  const address = token && local && domain ? `${local}+${token}@${domain}` : "";

  return (
    <div className="welcome">
      <ol className="stepper" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
            <span className="dot">{i < step ? <CheckIcon size={14} /> : i + 1}</span>
            <span className="label">{s}</span>
          </li>
        ))}
      </ol>

      <section className="card welcome-card">
        {step === 0 && <>
          <h1>Welcome to Receipt Catcher</h1>
          <p className="muted">A couple of quick steps and your receipts start collecting themselves. Everything here can be changed later in Settings.</p>
          <label className="field"><span>What does your business do? <span className="muted small">(optional — helps sort business vs personal, and taxes)</span></span>
            <textarea rows={3} value={business} onChange={(e) => setBusiness(e.target.value)}
              placeholder="e.g. I resell die-cast cars on my WooCommerce store and eBay, and buy inventory at Walmart and Target." />
          </label>
          <div className="welcome-actions"><button className="primary" onClick={saveBusiness}>Continue</button></div>
        </>}

        {step === 1 && <>
          <h1>Connect Gmail</h1>
          <p className="muted">Receipt emails from Walmart, Target, Amazon and other stores are picked up automatically every 30 minutes. Access is read-only and limited to receipts.</p>
          {gmail.length > 0 && <p className="ok"><CheckIcon size={16} /> Connected: {gmail.join(", ")}</p>}
          {error && <p className="error small">{error}</p>}
          <div className="welcome-actions">
            {gmail.length > 0
              ? <button className="primary" onClick={() => go(2)}>Continue</button>
              : <button className="primary" onClick={connectGmail}>Connect Gmail</button>}
            <button className="link" onClick={() => go(2)}>{gmail.length ? "Connect another later" : "Skip for now"}</button>
          </div>
        </>}

        {step === 2 && <>
          <h1>Your forwarding address</h1>
          <p className="muted">Forward receipts from any other inbox — or email a photo of a paper receipt — to this address.</p>
          {address ? (
            <div className="copy">
              <code>{address}</code>
              <button onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : <p className="muted small">Your forwarding address will appear here once email forwarding is set up for this app.</p>}
          <p className="muted small">Tip: add a filter in Gmail or Outlook that auto-forwards mail from your stores here.</p>
          <div className="welcome-actions"><button className="primary" onClick={() => go(3)}>Continue</button></div>
        </>}

        {step === 3 && <>
          <h1>Bring in past orders</h1>
          <p className="muted">On a computer, the Receipt Catcher browser extension imports your Walmart, Target and Amazon order history — including in-store purchases linked to your account — using your own signed-in browser. Install it, then create a connection code and paste it into the extension.</p>
          <ExtensionSection userId={userId} compact />
          <div className="welcome-actions"><button className="primary" onClick={() => go(4)}>Continue</button>
            <button className="link" onClick={() => go(4)}>I’ll do this later</button></div>
        </>}

        {step === 4 && <>
          <h1>You’re set</h1>
          <p className="muted">Got a paper receipt handy? Snap it now — it’s read in a few seconds. On your phone, add this page to your home screen for one-tap capture.</p>
          <div className="welcome-actions">
            <button className="primary" onClick={() => finish("/add")}><CameraIcon size={18} />Snap a receipt</button>
            <button onClick={() => finish("/")}>Go to Home</button>
          </div>
        </>}
      </section>

      {step < 4 && <p className="center-text"><button className="link muted" onClick={() => finish("/")}>Skip setup</button></p>}
      <p className="center-text small muted"><Link to="/settings">All settings</Link></p>
    </div>
  );
}
