# Chrome Web Store listing — copy/paste

Upload `extension/dist/receipt-catcher-extension-<version>.zip` (run `./extension/build.sh` first).
Screenshots: `extension/store/screenshot-*.png` (1280×800). Icon: `extension/icons/icon-128.png`.

## Store listing

**Name:** Receipt Catcher

**Summary (132 chars max):**
Import your Walmart, Target and Amazon order history — including in-store purchases — into your Receipt Catcher ledger.

**Category:** Productivity (or Shopping)

**Description:**
Receipt Catcher keeps every receipt in one searchable ledger with line items, cost per unit, Woo SKUs, tax categories and
QuickBooks / Xero exports. This extension brings in your store order history in bulk.

• Open your Walmart purchase history, Target orders (online and in-store) or Amazon Your Orders
• Click “Find orders on this page”, then “Import”
• Each order is opened in a background tab of your own signed-in browser, read, and added to Receipt Catcher
• Orders you already have are skipped automatically
• “Send just this page” captures a single receipt or order page from any store

Privacy: the extension only reads the order pages you choose to import, and only when you click Import or Send. It never
asks for, sees or stores your store passwords, and it does not track your browsing. Requires a Receipt Catcher account.

## Privacy practices tab

**Single purpose:**
Import the user's own purchase receipts and order history from store websites into their Receipt Catcher account.

**Permission justifications:**
- `storage` — Keeps the user's connection code and the progress of an import (which orders are queued and already imported).
- `tabs` — Opens each selected order page in a background tab and closes it after reading, so a long import runs without taking over the user's window.
- `scripting` — Reads the visible text of the order pages being imported and finds order links on the order-history page the user is viewing. Runs only after the user clicks Find orders, Import or Send.
- `activeTab` — Lets “Send just this page” read the current page on any store when the user clicks it.
- Host permission `walmart.com`, `target.com`, `amazon.com` — Needed to open and read the user's order pages on these stores during an import the user starts.
- Host permission `*.supabase.co` — Sends the order page text to the user's own Receipt Catcher account (our backend runs on Supabase).

**Remote code:** No, the extension does not use remote code. All JavaScript is included in the package.

**Data usage — collects:**
- Financial and payment information (order totals, card brand and last four digits as shown on the order page)
- Website content (text of the order pages the user imports)
- Personally identifiable information only as it appears on those order pages (e.g. shipping name)

**Certify:** not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** `https://<your-app-domain>/privacy`

## Distribution

Start with **Unlisted** (only people with the link can install), then switch to Public when you open sign-ups.
After approval, set `VITE_EXTENSION_STORE_URL` in Vercel to the listing URL — Settings and the setup guide then show
“Add to Chrome” instead of the .zip download.
