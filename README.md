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
supabase functions deploy sales-sync
supabase functions deploy payments-sync
supabase functions deploy shipping-sync
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
deno test --sloppy-imports web/tests                       # write-off rules, scenarios, mileage, missed write-offs
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

## Write-offs and mileage

**Reports → Write-offs** runs the year's line items through that year's IRS rules (`web/src/lib/taxrules.ts`, with sources)
and shows three ways to claim:
- **Conservative:** clear business items only.
- **Balanced:** recommended.
- **Maximum:** everything you can document.

Below the scenarios:
- **Totals by Schedule C line**, side by side for all three scenarios.
- **Missed write-offs**, with one-click fixes you review first:
  - personal items that look like your inventory
  - business supplies marked personal
  - unconfirmed items and mixed-use items without a %
  - de minimis / Section 179 equipment
  - un-logged store trips
  - home office, phone and internet, platform fees, ending inventory
- **Your answers for the year**, used in the calculations.
- **How to claim:** step-by-step directions for each line, including the de minimis election statement text.

**Reports → Mileage** turns store receipts into a mileage log. You set the round-trip distance to each store, review the
suggested trips, and add them to the log. Each trip uses the IRS rate for its date (2026 changed mid-year). Manual trips
can be added too, and the log exports as CSV.

**Updating the rules each year:**
1. Add the new year's figures to `TAX_RULES` once the IRS publishes them (inflation adjustments in Oct–Nov, mileage in December).
2. Run `deno test --sloppy-imports web/tests`.

These are estimates for organizing records, not tax advice.

## Team access

Settings → **Team** lets the account owner invite people (a bookkeeper, assistant or accountant) and choose, per area,
what they can do:

| Area | Covers | Levels |
| --- | --- | --- |
| Receipts | receipts, line items, photos, review queue, snapping | no access / view / edit |
| Reports & taxes | write-offs, mileage, inventory/COGS, exports | no access / view / edit |
| Settings | business description, categories | no access / view / edit |
| Team | inviting people and changing access | no access / manage |

Presets (Bookkeeper, Assistant, Accountant read-only, Admin) fill these in; "Fine-tune" sets each area by hand.
Creating an invite gives a one-time link (valid 7 days) to copy or email. The person opens it, signs up or signs in
**with the invited email**, and accepts. People who belong to more than one account pick one from the account bar under
the top navigation. Gmail, the forwarding address, the browser extension and the Claude connector always stay with the owner.

Access is enforced in the database: every table and the receipt files bucket check `can_access(owner, area, level)`
in row-level security (migration `team`), invite tokens are stored only as SHA-256 hashes, only the owner can grant or
remove team management, and nobody can change their own access. `process-upload` and `categorize-items` take an optional
`account` (owner id) and check the caller's access before acting on it.

## Receipts overview, stores and items

The Receipts page opens with an **overview** for a chosen period (this month, last 3 months, this year, last year,
last 12 months or all time), and respects the business filter:
- **Headline numbers:** spent, inventory, business expenses, personal and average order, each with the change vs the
  previous period of the same length.
- **To tidy up:** quick links for receipts that need review, receipts not assigned to a business, inventory items
  without a SKU, and spend not yet sorted into business or personal.
- **Spend by month:** stacked by inventory, business, personal and unsorted; hover or tap a month for its numbers.
- **Top stores:** tap one to see its receipts.

Below the overview are three views:
- **Receipts:** the list. Each row shows its item count and business and opens in place to show its items.
- **Stores:** one card per store with spend, orders, average basket, last visit, business share and top items.
  Spellings like "Walmart" and "WALMART.COM" are merged.
- **Items:** every product bought, merged across receipts by Woo SKU, then store SKU, then name. Shows times bought,
  units, spend, average and lowest landed unit cost (and where), last bought, and the purchase history, with search,
  filters and sorting.

Analytics are computed in the browser from `receipts` and the `inventory_lines` view (`web/src/lib/analytics.ts`,
unit-tested).

## Phone

- **Installable app:** a web app manifest plus `public/sw.js`. "Add to Home Screen" (iPhone) or "Install app" (Android)
  gives a full-screen app with a Snap shortcut. The service worker caches nothing, so deploys are live immediately and
  no receipt data stays on the device.
- **Android Share menu:** once installed, Receipt Catcher appears when sharing photos, screenshots or PDFs from any app
  (Photos, Gmail, store apps). Shared files go to `/share-target`; the service worker parks them, and the Snap page
  uploads them.
- **iPhone Shortcut:** Settings → Phone creates a connection code and shows the setup steps. The Shortcut posts the image to
  the `upload-receipt` function (raw JPEG/PNG/WebP/PDF or multipart `file`, `Authorization: Bearer rc_…`), which replies
  in plain text such as "Added to Receipt Catcher: Walmart $42.18".
- **No duplicates:** uploads are named by a fingerprint of the file's contents, so picking or sharing the same photo again
  returns "Already captured".

## Multiple businesses

Settings → **Businesses**: add each business (name, type, optional EIN, what it sells or does). For automatic
assignment, add the cards used for it (last 4 digits only) and the stores that are always for it.
- New receipts are assigned by card first, then by store (a database trigger, so it works for every import route).
  "Apply card/store rules" assigns existing receipts.
- On a receipt, pick its business. With two or more businesses, single items can be allocated to a different
  business than the rest of the receipt.
- **Expense categories per business:** Claude categorizes each item using the description of the business it belongs
  to. Use "Re-check expense categories with Claude" after adding a business or editing what it does.
- Reports has a **Business** picker. Write-offs, mileage, inventory, accounting export and IRS receipt images are
  worked out per business, each with its own answers (home office, inventory counts, store distances). Each sole
  proprietorship files its own Schedule C. S-corps, partnerships and C-corps get a reminder that they file a different return.
- Receipts can be filtered by business or "Not assigned", and Reports warns when receipts aren't assigned yet.

## Profit: sales, cost of goods and inventory on hand

Connect where you sell in **Settings → Sales** and **Reports → Profit** shows what you actually make, built from your receipts.

- **WooCommerce:** create a *Read* REST API key (WooCommerce → Settings → Advanced → REST API) and paste the store address, key and
  secret. The `sales-sync` function checks the key, stores it encrypted in Vault (`sales_secret_set/get`, service role only) and copies
  orders (changed-since cursor, a few pages per call) plus the product catalog with SKUs and stock. Fees come from the payment plugin's
  order notes (Stripe, WooPayments, PayPal, Square…). Stores re-sync when Profit opens if the last sync is over an hour old, or with
  **Sync now**. Store addresses must be public https sites; redirects are re-checked.
- **eBay, Etsy, Shopify or any CSV:** imported in the browser. eBay's transaction report brings fees, refunds and shipping labels;
  Etsy's order-items file and Shopify's orders export bring sales; *Other* lets you pick the columns. Re-importing the same orders
  updates them.
- **Stripe (source of truth for money):** paste a *restricted* key with Read on Charges and Refunds and on Balance (full secret
  keys are refused). `payments-sync` imports the account's charge history, then charges, refunds and disputes since the last sync,
  with Stripe's actual fee, into `payments`. Each charge is matched to its WooCommerce order by the transaction id Woo saves
  (`ch_…`/`pi_…`), else the `order_id` in the charge metadata (checked against the store's `site_url`). A matched order takes
  Stripe's amount, refunds, fee and outcome; it keeps its items (for cost of goods) and sales tax. Charges with no store order count
  as sales of their own. **Checked against Stripe** on the Profit tab lists charges with no order, Stripe-paid orders with no charge,
  amount differences and status disagreements. Logic: `web/src/lib/reconcile.ts`, `supabase/functions/_shared/stripe.ts`;
  migration `20261015152151_payments.sql`.
- **Easyship (shipping costs):** paste an API access token (shipment read). `shipping-sync` imports every shipment's label cost
  (bought labels only; voided or cancelled labels cost nothing), courier, tracking number and the store order number it was
  bought for into `shipments`. Labels are matched to orders by that number (WooCommerce orders first), after Stripe's corrections.
  Label costs count as a "Shipping labels" expense (receipts from Easyship are then left out so they aren't counted twice), and
  **Shipping vs. Easyship labels** on the Profit tab compares what customers paid for shipping against label cost and lists
  orders that lost money on shipping, refunded orders already shipped, labels with no order, and paid orders with no label (only
  for channels that ship with Easyship). Logic: `web/src/lib/shipping.ts`, `supabase/functions/_shared/easyship.ts`; migration
  `20261015173704_shipping.sql`.
- Only order totals, dates, SKUs and product names are kept — never buyer names, emails, addresses or card details.

Profit = sales (items + shipping, without sales tax) − refunds − cost of goods − fees − business expenses on receipts − mileage.
Cost of goods is units sold × each SKU's average landed cost across everything bought with that SKU, so purchases need the SKU they
sell under: **Match purchases to products** suggests SKUs from the store catalog and sold items. The tab also shows profit per
product, the Schedule C lines (1, 2, 4, 10 and 41), and inventory on hand (bought − sold per SKU at cost, next to the store's own
stock count); one click saves the year-end inventory and fees into Write-offs. Home shows this month's profit once sales are connected.

Tables: `sales_channels`, `sales_orders`, `sales_lines`, `sales_products` (migration `20261015132707_sales.sql`), in the *Reports*
area for team access. Pure logic and tests: `web/src/lib/pnl.ts`, `salesImport.ts`, `skuMatch.ts`, `supabase/functions/_shared/woo.ts`.

## Receipt images for the IRS

Every receipt has **Download for IRS (JPG)**, and Reports → Export has **Receipt images for the IRS**, which downloads a
year as a ZIP. Each JPG is a US-letter page (150 dpi) with the store, date, order number, payment (last 4 only),
each item with its business use, and the totals. Below that is the **original document exactly as captured**: the
photo, the email, or the text of the store's order page. Long receipts continue onto more pages, and original PDFs are
included unchanged. The ZIP holds folders of at most 40 files (the IRS Document Upload Tool takes JPG/PNG/PDF,
15 MB each, 40 per upload), plus `index.csv` and a README. Everything is drawn in the browser; nothing is uploaded.

Receipts aren't sent with a tax return. Keep them, and send only what an IRS letter or auditor asks for.

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

- **Row-level security everywhere.** Every table and the receipt-files bucket check `can_access(owner, area, level)`,
  so people only see their own account or what an owner shared with them (see Team access).
- **Two-step sign-in (TOTP).** Settings → Two-step sign-in. Once on, the database (restrictive `two-step sign-in`
  policies) and every edge function refuse sessions that skipped the code — a stolen password alone opens nothing,
  including the Claude connector consent and extension codes. Owners can require it for their whole team.
- **Confirm it's you.** Changing email, connecting Gmail or Claude, making an extension code, giving someone team
  management and turning off two-step sign-in ask for the 6-digit code (or password) again. This is a client-side
  guard against a computer left signed in; the server-side protections above don't depend on it.
- **Gmail refresh tokens live in Supabase Vault**, encrypted with a key kept outside the database. Only the
  service role can read them (`gmail_token_get`); disconnecting deletes the secret.
- **Short-lived file links.** Receipt photos/PDFs are private; the app signs 5-minute links and renews them while a
  receipt is open.
- **Security headers** (`vercel.json`, `public/_headers`): a strict Content-Security-Policy (scripts only from this
  site, data only to Supabase), no framing, HSTS, nosniff, a strict referrer policy and a locked-down permissions policy.
  If you move Supabase projects, update the project URL in the CSP.
- Extension codes, Claude connector tokens and invite links are random tokens stored only as SHA-256 hashes.
- Extraction never stores full card numbers; the model is told to keep only "Visa ending 1234".
