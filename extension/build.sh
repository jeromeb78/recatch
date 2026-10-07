#!/usr/bin/env bash
# Packages the extension for the Chrome Web Store and for the app's download link.
#   ./extension/build.sh   →  extension/dist/receipt-catcher-extension-<version>.zip
#                             web/public/receipt-catcher-extension.zip
set -euo pipefail
cd "$(dirname "$0")"
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
out="dist/receipt-catcher-extension-${version}.zip"
rm -f "$out"
zip -q -X -r "$out" manifest.json background.js stores.js popup.html popup.css popup.js icons
cp "$out" ../web/public/receipt-catcher-extension.zip
echo "Built $out ($(du -h "$out" | cut -f1)) and web/public/receipt-catcher-extension.zip"
