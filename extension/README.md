# Receipt Catcher browser extension

Imports order history from Walmart, Target and Amazon (and any single receipt page) into Receipt Catcher,
using the store sessions already signed in to this browser. No store passwords are stored anywhere.

## Install
- **From the Chrome Web Store** (once published): Settings → Browser extension → **Add to Chrome**.
- **From the app's download:** Settings → Browser extension → **Download extension (.zip)**, unzip into a folder you keep,
  `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the folder.
- **From this repo:** Load unpacked → pick this `extension/` folder.

Then in Receipt Catcher, **Settings → Browser extension → Create connection code**, click the extension icon, paste the code, **Connect**.

## Build and publish
`./extension/build.sh` creates `extension/dist/receipt-catcher-extension-<version>.zip` (upload this to the Chrome Web Store)
and refreshes `web/public/receipt-catcher-extension.zip` (the app's download link). Bump `version` in `manifest.json` for each
store upload. Listing text, permission justifications and screenshots: [`STORE_LISTING.md`](STORE_LISTING.md), `store/`.

## Use
1. Open your Walmart purchase history, Target orders (Online and In-store tabs), or Amazon Your Orders.
2. Load as many orders as you want on the page (scroll / "Load more" / change year), click **Find orders on this page**, then **Import**.
3. Orders open one at a time in a background tab (about 5–6 seconds each), are read, and appear in the app.
   Already-imported orders are skipped, both by the extension and by the server's dedupe.

## How it works
- `stores.js` — the only store-specific code: finds order links on the history page.
- `background.js` — the import queue: opens each order, reads its text, sends it to the `ingest-page` edge function.
- The server sends the page text to Claude, which extracts the receipt and line items like any other receipt.

If a store changes its page layout and "Find orders" stops finding them, update the matching pattern in `stores.js`.
