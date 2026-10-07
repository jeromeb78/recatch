# Receipt Catcher

Automatically capture receipts from Walmart, Target, Amazon and other stores into one searchable,
exportable ledger. It works like Tailride: receipts are pulled from your inbox, read by Claude,
and stored as structured data with line items.

**Three ways in:**

| Source | How it works |
|---|---|
| **Gmail sync** | Read-only OAuth. Every 30 min, it searches for receipt emails from known store domains (online orders, Target Circle / Walmart in-store e-receipts). PDF attachments are read too. |
| **Forwarding address** | Each user gets `inbound+<token>@yourdomain`. Forward a receipt email, or email a photo, and it gets captured. |
| **Photo / PDF upload** | Snap a paper receipt from your phone in the web app. |
| **Browser extension** | Bulk-imports Walmart, Target and Amazon order history (online and in-store purchases linked to the account) from your own signed-in browser. See [`extension/`](extension/README.md). |

Every receipt is deduplicated by email ID and by merchant + order number. The original PDF, image or HTML
is kept in private storage. Receipts that look off are flagged as **Needs review**: low confidence,
a missing total or date, or line items that don't add up to the subtotal.

## Stack

- **Supabase**: Postgres (with RLS), Auth (magic link), Storage, Edge Functions (Deno), pg_cron
- **Claude API**: receipt extraction with structured outputs (JSON schema), so the output is always strict JSON (text, PDFs and images). Model is `claude-opus-5-5` by default; override with `CLAUDE_MODEL`
- **Gmail REST API**: no SDK dependency
- **Postmark Inbound**: forwarding address (any inbound-email provider works with small changes)
- **React + Vite** dashboard

```
recatch/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 20261007021643_init.sql        # tables, RLS, storage bucket, views
│   │   └── 20261008000000_cron_sync.sql   # pg_cron job (apply after Vault secrets exist)
│   └── functions/
│       ├── _shared/        # extract (Claude), ingest pipeline, gmail helpers, utils, tests
│       ├── gmail-oauth/    # start consent + OAuth callback
│       ├── gmail-sync/     # cron + "Sync now" button
│       ├── inbound-email/  # Postmark webhook
│       ├── process-upload/ # photo/PDF uploads
│       ├── ingest-page/    # order pages sent by the browser extension
│       └── categorize-items/ # Schedule C categorization for older line items
├── extension/              # Chrome/Edge extension (Manifest V3, no build step)
└── web/                    # React dashboard
```

## Setup

### 1. Supabase project

```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push             # applies the init migration (and the cron one, see step 5)
```

> To apply only the first migration now, temporarily move `20261008000000_cron_sync.sql` out of the
> folder, or just finish step 5 (the Vault secrets) before running `db push`.

In **Authentication → URL Configuration**, set the Site URL to your dashboard URL and add `https://<your-domain>/**`
(and `http://localhost:5173/**` for development) to the redirect URLs, so sign-up confirmation (`/welcome`),
password reset (`/reset-password`) and email-change links work. Under **Authentication → Sign In / Providers → Email**,
keep **Confirm email** on. To make the app invite-only, turn off **Allow new users to sign up** and invite people from
**Authentication → Users**. For real use, set up custom SMTP (Authentication → Emails): Supabase's built-in sender
is rate-limited to a few emails an hour.

### 2. Google OAuth (Gmail)

1. Go to [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Set up the **OAuth consent screen**: User type *External*, then add the scopes `gmail.readonly` and `userinfo.email`.
3. Go to **Credentials → Create OAuth client ID → Web application** and add this authorized redirect URI:
   `https://<project-ref>.supabase.co/functions/v1/gmail-oauth`
4. Copy the client ID and secret.

> ⚠️ **Refresh tokens in "Testing" mode expire after 7 days.** For personal or family use, set the consent
> screen's publishing status to **In production** without submitting for verification. You'll click
> through an "unverified app" warning once, and unverified apps are capped at 100 users.
> `gmail.readonly` is a *restricted* scope. Offering this to the public as a SaaS
> requires Google verification plus an annual third-party security assessment (CASA).

### 3. Postmark inbound (forwarding address)

1. Create a Postmark server, then open its **Inbound** stream to get an address like `abc123@inbound.postmarkapp.com`.
   (Optional: point a custom domain's MX at Postmark so you can use `receipts@yourdomain.com`.)
2. Set the inbound webhook URL to
   `https://<project-ref>.supabase.co/functions/v1/inbound-email?secret=<INBOUND_SECRET>`
3. Users forward to `abc123+<their token>@inbound.postmarkapp.com`. The Settings page shows each user their own address.

### 4. Edge function secrets + deploy

```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill it in
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy gmail-oauth --no-verify-jwt
supabase functions deploy gmail-sync --no-verify-jwt
supabase functions deploy inbound-email --no-verify-jwt
supabase functions deploy process-upload
supabase functions deploy ingest-page --no-verify-jwt
supabase functions deploy categorize-items
supabase functions deploy mcp --no-verify-jwt
```

(`supabase functions deploy` with no name deploys all of them using the settings in `supabase/config.toml`.)

The `--no-verify-jwt` functions are called by Google, Postmark, pg_cron, the extension or Claude. They verify callers themselves
with an HMAC-signed OAuth state, a shared secret, a hashed connection code / OAuth token, or the user's JWT checked in code.

`APP_URL` must be the real app domain (e.g. `https://recatch.vercel.app`). The Claude connector's OAuth issuer and
resource URLs are built from it.

### 5. Schedule the sync (pg_cron)

Run this in the SQL editor using your real values:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET as the function env>', 'cron_secret');
```

Then apply `20261008000000_cron_sync.sql` (`supabase db push`, or paste it into the SQL editor).

### 6. Dashboard

```bash
cd web
cp .env.example .env.local     # Supabase URL + anon key + Postmark inbound address
npm install
npm run dev                    # http://localhost:5173
```

To deploy, import the repo into Vercel or Netlify, set the root to `web/`, and add the three `VITE_*` env vars.
SPA rewrites are already included (`vercel.json`, `public/_redirects`). Remember to update `APP_URL` and the Supabase Auth URLs to the production domain.

### Checks

```bash
cd web && npm run build                       # typecheck + production build
deno test supabase/functions/_shared          # validation rules, HTML→text, signed OAuth state
deno test --allow-env --allow-net supabase/functions/mcp   # OAuth + MCP end-to-end against a mock database
deno check supabase/functions/*/index.ts      # typecheck the edge functions
```

## Using it

1. Sign in with the magic link, open **Settings**, and click **Connect Gmail**. Then click **Backfill 12 months**.
   Each run handles up to 20 new emails per account (`SYNC_MAX_PER_RUN`). Click again, or let the
   30-minute cron catch up.
2. Copy your **forwarding address** for other inboxes. You can also add a Gmail filter that auto-forwards store emails to it.
3. Use **Add → Take photo** for paper receipts. iPhone HEIC photos need *Settings › Camera › Formats › Most Compatible*.
4. Categorize receipts and line items. Business categories (seeded: *Inventory (COGS)*, *Shipping Supplies*,
   *Office & Software*) roll up into the **Business** total.
5. Export **receipts CSV** or **line items CSV** for your accountant or QuickBooks import. Line items have a
   `woo_sku` field, so you can map store purchases to your own product SKUs and track per-unit cost.

## Accounts

- **Sign up / sign in** with email + password, or a one-time email link. Email addresses are confirmed before first sign-in.
- **Forgot password** emails a reset link that opens *Choose a new password*.
- **Setup guide** (`/welcome`) runs once after sign-up: business description → Gmail → forwarding address → browser extension → first photo.
- **Settings → Account**: change password or email, sign out (or sign out on every device), re-run the setup guide.

## Taxes, inventory and accounting exports

- Every line item gets a **Schedule C line**, **business / personal / mixed** flag and a confidence score from Claude,
  guided by *Settings → Your business*. Older items: **Reports → Taxes → Categorize now**. Edit any item on its receipt.
  These are organizing suggestions, not tax advice.
- **Pack size** turns a 24-count case into 24 units. **Landed cost** spreads each order's tax, shipping and discounts across its items.
- **Reports → Inventory & COGS**: units, spend, average and latest landed cost per Woo SKU, and unmapped inventory items.
- **Reports → Export**: QuickBooks Online bank upload, QuickBooks itemized expenses, Xero bank statement and Xero bills CSVs,
  with an account mapping per tax line and personal items left out by default. Check the columns against your import screen the first time.

## Browser extension

`extension/` is a Manifest V3 Chrome extension that bulk-imports Walmart, Target and Amazon order history from the
user's own signed-in browser. `./extension/build.sh` zips it to `extension/dist/` and copies the zip to
`web/public/receipt-catcher-extension.zip`, which Settings offers as a download (Load unpacked) until it's in the store.
To publish, follow `extension/STORE_LISTING.md` (listing text, permission justifications, screenshots in `extension/store/`,
privacy policy at `/privacy`), then set `VITE_EXTENSION_STORE_URL` and `VITE_CONTACT_EMAIL` in Vercel.

## Claude connector (MCP)

The `mcp` function is a remote MCP server with its own OAuth 2.1 (dynamic client registration, PKCE, rotating refresh
tokens, all stored hashed). Users add it in Claude under **Settings → Connectors → Add custom connector** with
`https://<your-app-domain>/mcp`, then approve on the app's `/oauth/authorize` screen. Tools: `add_receipt`,
`check_imported`, `search_receipts`, `get_receipt`, `spending_summary`, `inventory_costs`, `update_line_item`.

- OAuth discovery must live at the domain root, so `web/vercel.json` (and `public/_redirects`) proxy `/mcp`,
  `/.well-known/oauth-*` and `/oauth/register|token` to the function. **They hardcode the Supabase project ref**; change it if you fork.
- With Claude in Chrome, Claude can open order pages and call `add_receipt` — the same dedupe key as the extension, so nothing is imported twice.
- Settings → Claude lists connected apps; Disconnect revokes their tokens.

## Getting in-store receipts by email

- **Target:** In-store purchases linked to your Target Circle account appear in the app's purchase history. Target can email receipts at checkout, and those emails are picked up by Gmail sync.
- **Walmart:** Paying with Walmart Pay or a card linked to your Walmart account puts receipts in the app. You can share them to your email or forwarding address.
- **Everything else:** Use the photo upload.

## Extending

- **More stores:** set `RECEIPT_SENDERS=walmart.com,target.com,...` on the functions.
- **Different inbound provider** (SendGrid, Mailgun, Cloudflare Email Workers): adapt the payload parsing in `inbound-email/index.ts`.
- **QuickBooks / Xero push:** add a function that reads `receipts` where `status = 'ready'` and posts expenses.
- **Server-side portal scraping** (logging in to store accounts from a server) was deliberately left out: it breaks often,
  trips bot detection and needs stored passwords. The browser extension reads order pages from the user's own signed-in browser instead,
  at a slow, user-started pace. If a store changes its order pages, update the link patterns in `extension/stores.js`.

## Security notes

- Gmail refresh tokens live in `email_connections`. Browser clients can't select the `refresh_token` column; only the service role reads it.
- Every table has RLS limited to `auth.uid()`. Storage objects live under `{user_id}/…` with matching policies.
- Extraction never stores full card numbers; the model is told to keep only "Visa ending 1234".
- Consider encrypting `refresh_token` with pgsodium/Vault if you open this up beyond your household.
- Extension connection codes are random 256-bit tokens; only their SHA-256 hash is stored (`api_tokens`). Revoke them in Settings.
