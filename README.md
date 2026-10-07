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
│   │   ├── 20261006000000_init.sql        # tables, RLS, storage bucket, views
│   │   └── 20261006000100_cron_sync.sql   # pg_cron job (apply after Vault secrets exist)
│   └── functions/
│       ├── _shared/        # extract (Claude), ingest pipeline, gmail helpers, utils, tests
│       ├── gmail-oauth/    # start consent + OAuth callback
│       ├── gmail-sync/     # cron + "Sync now" button
│       ├── inbound-email/  # Postmark webhook
│       └── process-upload/ # photo/PDF uploads
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

> To apply only the first migration now, temporarily move `20261006000100_cron_sync.sql` out of the
> folder, or just finish step 5 (the Vault secrets) before running `db push`.

In **Auth → URL Configuration**, set the Site URL to your dashboard URL and add it to the redirect URLs.

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
```

The `--no-verify-jwt` functions are called by Google, Postmark or pg_cron. They verify callers themselves
with an HMAC-signed OAuth state, a shared secret, or the user's JWT checked in code.

### 5. Schedule the sync (pg_cron)

Run this in the SQL editor using your real values:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET as the function env>', 'cron_secret');
```

Then apply `20261006000100_cron_sync.sql` (`supabase db push`, or paste it into the SQL editor).

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

## Getting in-store receipts by email

- **Target:** In-store purchases linked to your Target Circle account appear in the app's purchase history. Target can email receipts at checkout, and those emails are picked up by Gmail sync.
- **Walmart:** Paying with Walmart Pay or a card linked to your Walmart account puts receipts in the app. You can share them to your email or forwarding address.
- **Everything else:** Use the photo upload.

## Extending

- **More stores:** set `RECEIPT_SENDERS=walmart.com,target.com,...` on the functions.
- **Different inbound provider** (SendGrid, Mailgun, Cloudflare Email Workers): adapt the payload parsing in `inbound-email/index.ts`.
- **QuickBooks / Xero push:** add a function that reads `receipts` where `status = 'ready'` and posts expenses.
- **Portal scraping** (Walmart/Target order history) was deliberately left out. It breaks often, trips bot detection, and conflicts with store terms.

## Security notes

- Gmail refresh tokens live in `email_connections`. Browser clients can't select the `refresh_token` column; only the service role reads it.
- Every table has RLS limited to `auth.uid()`. Storage objects live under `{user_id}/…` with matching policies.
- Extraction never stores full card numbers; the model is told to keep only "Visa ending 1234".
- Consider encrypting `refresh_token` with pgsodium/Vault if you open this up beyond your household.
