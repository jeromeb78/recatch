import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useConfirmIdentity } from "./ConfirmIdentity";

const ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-receipt`;

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "rc_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Copy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code>{value}</code>
      <button type="button" aria-label={`Copy ${label}`} onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** Settings → Phone: install the app, share receipts from other apps, and the iPhone Shortcut. */
export function PhoneSection({ userId }: { userId: string }) {
  const confirmIdentity = useConfirmIdentity();
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia?.("(display-mode: standalone)").matches ?? false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstall(e as InstallEvent); };
    const onInstalled = () => { setInstalled(true); setInstall(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function makeCode() {
    setError(null);
    if (!(await confirmIdentity("The iPhone Shortcut will be able to add receipts to your account."))) return;
    const token = randomToken();
    const { error } = await supabase.from("api_tokens").insert({
      user_id: userId,
      name: `iPhone Shortcut · ${new Date().toLocaleDateString()}`,
      token_hash: await sha256Hex(token),
    });
    if (error) return setError(error.message);
    setCode(token);
  }

  return (
    <section className="card stack-sm" id="phone">
      <h2>Phone</h2>
      <p className="muted small">
        Get receipts that are already on your phone — photos, screenshots of e-receipts, PDFs from store apps or email — into
        Receipt Catcher without opening a computer.
      </p>

      <h3>1 · Put Receipt Catcher on your home screen</h3>
      {installed ? (
        <p className="ok small">Installed on this device.</p>
      ) : install ? (
        <button className="primary" onClick={async () => { await install.prompt(); setInstall(null); }}>Install app</button>
      ) : ios ? (
        <p className="small">In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>. It opens full-screen like an app.</p>
      ) : (
        <p className="small">Open this site on your phone. Android (Chrome): menu ⋮ → <b>Install app</b>. iPhone (Safari): Share → <b>Add to Home Screen</b>.</p>
      )}

      <h3>2 · Android: share from any app</h3>
      <p className="small">
        Once installed, <b>Receipt Catcher</b> appears in the Share menu. In Photos, Gmail, Walmart, Target, Amazon or Files, select
        one or many receipts → Share → Receipt Catcher. They're read and added; ones already added are skipped.
      </p>

      <h3>3 · iPhone: share with a Shortcut</h3>
      <p className="small">
        iPhone doesn't let web apps appear in the Share menu, so a Shortcut sends the photo instead (about 2 minutes to set up,
        once). It's also the fastest way on iPhone: Share → <b>Add to Receipt Catcher</b>.
      </p>
      {!code ? (
        <div className="actions tight"><button onClick={makeCode}>Create a Shortcut code</button></div>
      ) : (
        <div className="banner ok shortcut-code">
          <b>Copy these now — the code is shown only once.</b>
          <span className="small">Web address</span>
          <Copy value={ENDPOINT} label="web address" />
          <span className="small">Header value</span>
          <Copy value={`Bearer ${code}`} label="header value" />
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <details className="small" open={!!code}>
        <summary>Set up the Shortcut</summary>
        <ol className="guide-list shortcut-steps">
          <li>Open the <b>Shortcuts</b> app → <b>+</b>. Name it <b>Add to Receipt Catcher</b>.</li>
          <li>Tap the <b>ⓘ</b> (Details) → turn on <b>Show in Share Sheet</b>. Set it to receive <b>Images</b> (and turn off the rest).</li>
          <li>Add <b>Repeat with Each</b> → <i>Shortcut Input</i>. Inside the repeat:
            <ol>
              <li><b>Convert Image</b> → <i>Repeat Item</i> to <b>JPEG</b>.</li>
              <li><b>Resize Image</b> → <i>Converted Image</i>, width <b>2000</b>.</li>
              <li><b>Get Contents of URL</b> → paste the web address. Tap <b>Show More</b>: Method <b>POST</b>; add a Header
                named <b>Authorization</b> with the header value; Request Body <b>File</b> → <i>Resized Image</i>.</li>
              <li><b>Show Notification</b> → <i>Contents of URL</i>.</li>
            </ol>
          </li>
          <li>Done. In Photos, select one or many receipts → Share → <b>Add to Receipt Catcher</b>. You'll see “Added to Receipt
            Catcher: Walmart $42.18” for each.</li>
          <li>Optional: Settings → Accessibility → Touch → <b>Back Tap</b> → Double Tap → your Shortcut, to send the screenshot you
            just took.</li>
        </ol>
        <p className="muted small">
          PDFs (store app invoices) work best via <b>Snap → Choose photos or PDFs</b> in the app, or by emailing them to your
          forwarding address. Lost your phone? Revoke the Shortcut code under Browser extension → connected codes.
        </p>
      </details>
    </section>
  );
}
