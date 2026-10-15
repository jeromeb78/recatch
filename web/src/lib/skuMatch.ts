// Suggests which store SKU an item you bought is, from words the two names share. Pure, for tests.
// "Hot Wheels '67 Camaro Red 1:64" ↔ "HW 67 Camaro (red)" share "67", "camaro", "red".

export interface Candidate { sku: string; name: string }
export interface Suggestion { sku: string; name: string; score: number }

const STOP = new Set(["the", "and", "with", "for", "of", "a", "an", "in", "new", "pack", "pk", "count", "ct", "each", "set", "assorted",
  "styles", "style", "may", "vary", "color", "colors", "size", "item", "items", "by", "to", "from", "on"]);

const ALIASES: Record<string, string> = { hw: "hotwheels", hotwheel: "hotwheels", mb: "matchbox" };

/** Lowercase words without filler; "Hot Wheels" → "hotwheels" so brand names line up. */
export function tokens(s: string): string[] {
  const words = s.toLowerCase().replace(/hot\s*wheels?/g, "hotwheels").replace(/['’]/g, "")
    .split(/[^a-z0-9.:]+/).map((w) => w.replace(/^[.:]+|[.:]+$/g, "")).filter((w) => w && !STOP.has(w));
  return [...new Set(words.map((w) => ALIASES[w] ?? w))];
}

/** 0..1 — how much of the shorter name the other covers. Numbers (model years, scales, part numbers) count double. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = new Set(tokens(b));
  if (!ta.length || !tb.size) return 0;
  const weight = (w: string) => (/\d/.test(w) ? 2 : 1);
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += weight(w);
  const wa = ta.reduce((s, w) => s + weight(w), 0);
  const wb = [...tb].reduce((s, w) => s + weight(w), 0);
  return shared / Math.min(wa, wb) * (shared / Math.max(wa, wb)) ** 0.25;
}

/** Best SKU guesses for an item, strongest first. A SKU written inside the item name wins outright. */
export function suggest(item: string, candidates: Candidate[], limit = 3, min = 0.34): Suggestion[] {
  const lower = item.toLowerCase();
  const out: Suggestion[] = [];
  for (const c of candidates) {
    const exact = c.sku.length >= 4 && new RegExp(`(^|[^a-z0-9])${c.sku.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(lower);
    const score = exact ? 1 : similarity(item, c.name);
    if (score >= min) out.push({ sku: c.sku, name: c.name, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** One entry per distinct SKU from the store catalog and from what was sold (sold names fill gaps). */
export function candidatesFrom(products: Candidate[], sold: { sku: string | null; name: string }[]): Candidate[] {
  const m = new Map<string, Candidate>();
  for (const p of products) if (p.sku?.trim()) m.set(p.sku.trim().toUpperCase(), { sku: p.sku.trim(), name: p.name });
  for (const s of sold) if (s.sku?.trim() && !m.has(s.sku.trim().toUpperCase())) m.set(s.sku.trim().toUpperCase(), { sku: s.sku.trim(), name: s.name });
  return [...m.values()];
}
