// Per-category totals for the Receipts overview: what was spent in each receipt category and what of it is a likely
// write-off, item by item, using the same tax rules as Reports → Write-offs (balanced scenario). Pure, for tests.

import { itemDeduction, lineLabel, type WLine } from "./writeoffs";
import { rulesFor } from "./taxrules";
import { signed, type ALine, type AReceipt } from "./analytics";

export interface CategoryInfo { id: string; name: string; is_business: boolean; color?: string | null }

export interface CategoryStat {
  /** Category id, or "none" for receipts without one. */
  id: string;
  name: string;
  isBusiness: boolean;
  color: string | null;
  spend: number;
  receipts: number;
  prevSpend: number | null;
  /** Likely deductible amount, by Schedule C line, largest first. Inventory is listed as "cogs" (deducted as it sells). */
  writeOffs: { line: string; label: string; amount: number }[];
  writeOffTotal: number;
  /** Personal costs that may still be deductible elsewhere (e.g. medical on Schedule A). */
  personalNote: { label: string; amount: number } | null;
}

const PERSONAL_DEDUCTIONS: [RegExp, string][] = [
  [/medic|health|dental|pharm|doctor|vision|hospital/i, "Possible itemized deduction (Schedule A): medical costs above 7.5% of income, if you itemize"],
  [/charit|donat|church|tithe/i, "Possible itemized deduction (Schedule A): charitable gifts, if you itemize"],
];

const r2 = (v: number) => Math.round(v * 100) / 100;

function asWLine(l: ALine): WLine {
  return {
    id: l.id, receipt_id: l.receipt_id, description: l.description, landed_total: Number(l.landed_total) || 0, tax_line: l.tax_line,
    use_type: (l.use_type as WLine["use_type"]) ?? null, business_pct: l.business_pct ?? null, quantity: Number(l.quantity) || null,
    unit_price: null, tax_confidence: null, is_business: false, purchase_date: l.purchase_date, woo_sku: l.woo_sku, merchant: l.merchant,
  };
}

export function categoryStats(args: {
  receipts: AReceipt[];
  lines: ALine[];
  categories: CategoryInfo[];
  prevReceipts?: AReceipt[] | null;
}): CategoryStat[] {
  const catOf = new Map(args.receipts.map((r) => [r.id, r.category_id ?? "none"]));
  const byId = new Map(args.categories.map((c) => [c.id, c]));
  const out = new Map<string, CategoryStat & { _lines: Map<string, number> }>();
  const stat = (id: string) => {
    let s = out.get(id);
    if (!s) {
      const c = byId.get(id);
      s = {
        id, name: c?.name ?? "No category", isBusiness: !!c?.is_business, color: c?.color ?? null, spend: 0, receipts: 0,
        prevSpend: args.prevReceipts ? 0 : null, writeOffs: [], writeOffTotal: 0, personalNote: null, _lines: new Map(),
      };
      out.set(id, s);
    }
    return s;
  };

  for (const r of args.receipts) {
    const s = stat(r.category_id ?? "none");
    s.spend += signed(r);
    s.receipts++;
  }
  for (const r of args.prevReceipts ?? []) {
    const id = r.category_id ?? "none";
    if (!out.has(id)) continue; // only categories with spending this period get a card
    out.get(id)!.prevSpend! += signed(r);
  }
  for (const l of args.lines) {
    const id = catOf.get(l.receipt_id);
    if (!id) continue;
    const year = Number((l.purchase_date ?? "").slice(0, 4)) || new Date().getFullYear();
    const d = itemDeduction(asWLine(l), "balanced", rulesFor(year));
    if (!d) continue;
    const s = stat(id);
    s._lines.set(d.line, (s._lines.get(d.line) ?? 0) + d.amount);
  }

  return [...out.values()].map(({ _lines, ...s }) => {
    const writeOffs = [..._lines].map(([line, amount]) => ({ line, label: lineLabel(line), amount: r2(amount) }))
      .filter((w) => w.amount > 0).sort((a, b) => b.amount - a.amount);
    const writeOffTotal = r2(writeOffs.reduce((a, w) => a + w.amount, 0));
    const note = !s.isBusiness ? PERSONAL_DEDUCTIONS.find(([re]) => re.test(s.name)) : undefined;
    return {
      ...s, spend: r2(s.spend), prevSpend: s.prevSpend === null ? null : r2(s.prevSpend), writeOffs, writeOffTotal,
      personalNote: note ? { label: note[1], amount: r2(s.spend) } : null,
    };
  }).sort((a, b) => Number(b.isBusiness) - Number(a.isBusiness) || b.spend - a.spend);
}
