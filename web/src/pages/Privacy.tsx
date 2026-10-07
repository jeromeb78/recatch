import { Link } from "react-router-dom";

const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) || "";

/** Public page (no sign-in): required for the Chrome Web Store listing and the Google consent screen. */
export default function Privacy() {
  return (
    <div className="app">
      <main className="doc">
        <p><Link to="/">← Receipt Catcher</Link></p>
        <h1>Privacy policy</h1>
        <p className="muted small">Last updated October 2026</p>

        <h2>What Receipt Catcher does</h2>
        <p>Receipt Catcher collects your purchase receipts into one ledger so you can track spending, inventory costs and
          business expenses. It only stores data you choose to bring in.</p>

        <h2>Data we collect</h2>
        <ul>
          <li><b>Account:</b> your email address and a password hash (managed by our authentication provider, Supabase).</li>
          <li><b>Receipts:</b> receipts you capture from Gmail, forwarded emails, uploaded photos/PDFs, the browser extension or the Claude connector — merchant, date, amounts, payment method (card brand and last four digits only), line items, and the original email, page text or image.</li>
          <li><b>Gmail (optional):</b> with read-only permission, we search for emails from known store domains and read only those messages and their PDF attachments. We do not read, store or use other email.</li>
          <li><b>Browser extension (optional):</b> when you click Import or Send, it reads the visible text of the order pages you choose on supported stores and sends it to your account. It does not track browsing, run on other sites, or access store passwords.</li>
          <li><b>Claude connector (optional):</b> when you connect Claude, it can read and add receipts in your account using the tools you approve.</li>
        </ul>

        <h2>How we use it</h2>
        <p>Only to provide the service: extracting receipt details, organizing, searching, reporting and exporting your data.
          Receipt contents are sent to Anthropic’s Claude API to read them. Under its commercial terms, Anthropic does not train its models on this API data by default.
          We do not sell your data, use it for advertising, or share it with anyone except the service providers that run
          the app (Supabase for database, storage and authentication; Anthropic for receipt reading; Postmark for inbound email;
          our hosting provider).</p>
        <p>Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>

        <h2>Security and retention</h2>
        <p>Data is encrypted in transit, stored in a private database with per-user access rules, and kept until you delete it.
          Connection codes and access tokens are stored only as one-way hashes. You can disconnect Gmail, the extension or
          Claude at any time in Settings, delete individual receipts, or ask us to delete your account and all its data.</p>

        <h2>Contact</h2>
        <p>{CONTACT ? <>Questions or deletion requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</> : "Questions or deletion requests: use the contact address on our Chrome Web Store listing."}</p>
      </main>
    </div>
  );
}
