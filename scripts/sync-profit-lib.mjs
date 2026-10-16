// Copies the app's pure profit logic (web/src/lib) into the edge functions (supabase/functions/_shared/profit) so the
// Claude connector computes exactly what the Profit tab shows. Deno needs explicit ".ts" import paths, so those are added.
//   node scripts/sync-profit-lib.mjs          write the copies
//   node scripts/sync-profit-lib.mjs --check  fail if a copy is out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["pnl", "costs", "reconcile", "shipping", "writeoffs", "taxrules", "tax"];
const src = join(root, "web/src/lib");
const out = join(root, "supabase/functions/_shared/profit");
const check = process.argv.includes("--check");

mkdirSync(out, { recursive: true });
let stale = [];
for (const f of FILES) {
  const body = readFileSync(join(src, `${f}.ts`), "utf8")
    .replace(/(from\s+["'])(\.\/[^"']+?)(["'])/g, (m, a, p, b) => (p.endsWith(".ts") ? m : `${a}${p}.ts${b}`));
  const text = `// GENERATED from web/src/lib/${f}.ts by scripts/sync-profit-lib.mjs — edit the original, then re-run the script.\n${body}`;
  const dest = join(out, `${f}.ts`);
  if (check) { if (!existsSync(dest) || readFileSync(dest, "utf8") !== text) stale.push(f); }
  else writeFileSync(dest, text);
}
if (check && stale.length) { console.error(`Out of date: ${stale.join(", ")}. Run node scripts/sync-profit-lib.mjs`); process.exit(1); }
console.log(check ? "profit lib copies are up to date" : `wrote ${FILES.length} files to supabase/functions/_shared/profit`);
