// Write-off finder: runs a year's line items, trips and the user's answers through that year's tax rules
// (taxrules.ts) under three scenarios, finds missed write-offs, and says how to claim each one.
// Pure functions only, so it can be unit tested and reused.
import { TAX_LINES } from "./tax";
import { mileageRate, rulesFor, SOURCES, type TaxYearRules } from "./taxrules";

export type Scenario = "conservative" | "balanced" | "maximum";
export const SCENARIOS: Scenario[] = ["conservative", "balanced", "maximum"];

export const SCENARIO_INFO: Record<Scenario, { label: string; blurb: string }> = {
  conservative: {
    label: "Conservative",
    blurb: "Only clear business items. Mixed items count only once you set a business %. Mileage only from your saved log. Big equipment depreciated over 5 years.",
  },
  balanced: {
    label: "Balanced",
    blurb: "Recommended. Every business item, mixed items at your % (50% until you set one), store trips that look in-person, and equipment over $2,500 written off in year one.",
  },
  maximum: {
    label: "Maximum",
    blurb: "Everything you can document: also low-confidence items, every store trip with a distance, and the better of the two home-office and car methods. Needs the strongest records.",
  },
};

/** Schedule C lines the finder uses beyond the per-item tax lines. */
export const EXTRA_LINES: Record<string, string> = {
  c10: "Line 10 · Commissions and fees",
  c30: "Line 30 · Business use of home",
  uncat: "Business items not categorized yet",
};
export const lineLabel = (k: string) => TAX_LINES[k] ?? EXTRA_LINES[k] ?? k;

export interface WLine {
  id: string;
  receipt_id: string;
  description: string;
  tax_line: string | null;
  use_type: "business" | "personal" | "mixed" | null;
  tax_confidence: number | null;
  business_pct: number | null;
  landed_total: number | null;
  unit_price: number | null;
  quantity: number | null;
  woo_sku: string | null;
  is_business: boolean;
  purchase_date: string | null;
  merchant: string | null;
}

export interface WReceipt {
  id: string;
  purchase_date: string | null;
  merchant: string | null;
  total: number | null;
  shipping: number | null;
  document_type: string;
}

export interface Trip {
  id?: string;
  trip_date: string;
  destination: string;
  purpose: string;
  miles: number;
  merchant_key: string | null;
  receipt_ids: string[];
}

export interface YearInputs {
  scenario?: Scenario;
  homeOffice?: { sqft?: number; homeSqft?: number; rent?: number; utilities?: number; insurance?: number; repairs?: number };
  phone?: { monthly?: number; pct?: number };
  internet?: { monthly?: number; pct?: number };
  fees?: { platform?: number; payment?: number; software?: number; advertising?: number; other?: number };
  inventory?: { begin?: number; end?: number };
  vehicle?: { totalMiles?: number; costs?: number };
  deMinimisElection?: boolean;
}

export interface TaxProfile {
  store_miles?: Record<string, number>;
  years?: Record<string, YearInputs>;
}

export interface Contribution {
  line: string;
  amount: number;
  source: string; // short label of where it came from
}

export interface ScenarioResult {
  scenario: Scenario;
  total: number;
  lines: Record<string, number>;
  contributions: Contribution[];
  assumptions: string[];
}

export interface SuggestedTrip extends Trip {
  likelyInStore: boolean;
  receipts: number;
}

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function merchantKey(merchant: string | null): string | null {
  const k = (merchant ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return k || null;
}

/* ---------------- mileage ---------------- */

/** One candidate trip per store per day, from receipts not already in the mileage log. */
export function suggestTrips(receipts: WReceipt[], saved: Trip[], storeMiles: Record<string, number>): SuggestedTrip[] {
  const logged = new Set(saved.flatMap((t) => t.receipt_ids));
  const loggedDays = new Set(saved.filter((t) => t.merchant_key).map((t) => `${t.trip_date}|${t.merchant_key}`));
  const by = new Map<string, SuggestedTrip>();
  for (const r of receipts) {
    const key = merchantKey(r.merchant);
    if (!r.purchase_date || !key || r.document_type === "refund" || logged.has(r.id)) continue;
    const id = `${r.purchase_date}|${key}`;
    if (loggedDays.has(id)) continue;
    const t = by.get(id) ?? {
      trip_date: r.purchase_date,
      destination: r.merchant ?? key,
      purpose: "Buying inventory and supplies",
      miles: storeMiles[key] ?? 0,
      merchant_key: key,
      receipt_ids: [],
      likelyInStore: false,
      receipts: 0,
    };
    t.receipt_ids.push(r.id);
    t.receipts++;
    // Orders with a shipping charge were probably delivered; any receipt without one suggests a store visit.
    if (!(n(r.shipping) > 0)) t.likelyInStore = true;
    by.set(id, t);
  }
  return [...by.values()].sort((a, b) => a.trip_date.localeCompare(b.trip_date));
}

export function tripValue(t: { trip_date: string; miles: number }): number {
  return r2(n(t.miles) * mileageRate(t.trip_date));
}

/* ---------------- deductions ---------------- */

/** Deductible amount and Schedule C line for one item under a scenario (null = not deductible). */
export function itemDeduction(l: WLine, scenario: Scenario, rules: TaxYearRules): { line: string; amount: number; note?: string } | null {
  let v = n(l.landed_total);
  if (v <= 0) return null;
  if (l.tax_line === "personal" || l.use_type === "personal") return null;
  if (!l.tax_line) return scenario === "maximum" && l.is_business ? { line: "uncat", amount: v } : null;
  if (scenario === "conservative" && l.tax_confidence != null && l.tax_confidence < 0.6) return null;

  let note: string | undefined;
  if (l.use_type === "mixed") {
    const pct = l.business_pct ?? (scenario === "conservative" ? 0 : 50);
    if (!pct) return null;
    v = (v * pct) / 100;
    note = `${pct}% business`;
  }
  if (l.tax_line === "c24b") {
    v = (v * rules.mealsPct) / 100;
    note = `${rules.mealsPct}% of meals`;
  }
  if (l.tax_line === "c13") {
    const qty = n(l.quantity) || 1;
    const unit = l.unit_price != null ? n(l.unit_price) : n(l.landed_total) / qty;
    if (unit > rules.deMinimis && scenario === "conservative") {
      // 5-year property, half-year convention: 20% in year one.
      v = v * 0.2;
      note = "depreciated: 20% in year one";
    } else if (unit > rules.deMinimis) {
      note = rules.bonusPct >= 100 ? "100% bonus depreciation / Section 179" : `Section 179 (bonus is ${rules.bonusPct}%)`;
    } else {
      note = `de minimis safe harbor (≤ $${rules.deMinimis.toLocaleString()} each)`;
    }
  }
  return { line: l.tax_line, amount: r2(v), note };
}

export function homeOfficeAmounts(h: YearInputs["homeOffice"], rules: TaxYearRules) {
  const sqft = n(h?.sqft);
  const simplified = r2(Math.min(sqft, rules.homeOffice.maxSqft) * rules.homeOffice.ratePerSqft);
  const homeSqft = n(h?.homeSqft);
  const costs = n(h?.rent) + n(h?.utilities) + n(h?.insurance) + n(h?.repairs);
  const regular = homeSqft > 0 && sqft > 0 ? r2((Math.min(sqft, homeSqft) / homeSqft) * costs) : 0;
  return { simplified, regular };
}

export function runScenario(args: {
  year: number;
  scenario: Scenario;
  lines: WLine[];
  trips: Trip[];
  suggested: SuggestedTrip[];
  inputs: YearInputs;
}): ScenarioResult {
  const { year, scenario, lines, trips, suggested, inputs } = args;
  const rules = rulesFor(year);
  const out: Contribution[] = [];
  const assumptions: string[] = [];
  const add = (line: string, amount: number, source: string) => amount > 0 && out.push({ line, amount: r2(amount), source });

  // Receipt items. Inventory (COGS) is adjusted for inventory on hand below.
  let purchases = 0;
  for (const l of lines) {
    const d = itemDeduction(l, scenario, rules);
    if (!d) continue;
    if (d.line === "cogs") purchases += d.amount;
    else add(d.line, d.amount, d.note ? `Receipt items (${d.note})` : "Receipt items");
  }
  const inv = inputs.inventory ?? {};
  if (purchases > 0 || n(inv.begin) > 0) {
    if (inv.end != null) {
      add("cogs", n(inv.begin) + purchases - n(inv.end), "Beginning inventory + purchases − ending inventory");
    } else {
      add("cogs", purchases, "Inventory purchases (enter ending inventory to get true COGS)");
      assumptions.push("COGS uses all inventory purchases because ending inventory isn’t entered yet — unsold stock isn’t deductible until sold.");
    }
  }

  // Mileage: saved log, plus suggested store trips depending on scenario.
  const savedMiles = trips.reduce((a, t) => a + n(t.miles), 0);
  let mileage = trips.reduce((a, t) => a + tripValue(t), 0);
  let miles = savedMiles;
  const extra = scenario === "conservative" ? [] : suggested.filter((t) => t.miles > 0 && (scenario === "maximum" || t.likelyInStore));
  for (const t of extra) {
    mileage += tripValue(t);
    miles += t.miles;
  }
  if (extra.length) assumptions.push(`Includes ${plural(extra.length, "store trip")} not yet in your mileage log — add them in Mileage to keep the record.`);
  const v = inputs.vehicle ?? {};
  if (scenario === "maximum" && n(v.totalMiles) > 0 && n(v.costs) > 0 && miles > 0) {
    const actual = r2((n(v.costs) * Math.min(miles, n(v.totalMiles))) / n(v.totalMiles));
    if (actual > mileage) {
      add("c9", actual, `Actual car expenses × ${Math.round((miles / n(v.totalMiles)) * 100)}% business use`);
      assumptions.push("Car: actual expenses beat the standard mileage rate. Once you use actual expenses for a car, you can’t switch it to the mileage rate later.");
    } else add("c9", mileage, `${Math.round(miles)} business miles × IRS rate`);
  } else add("c9", mileage, `${Math.round(miles)} business miles × IRS rate`);

  // Home office.
  const ho = homeOfficeAmounts(inputs.homeOffice, rules);
  if (scenario === "maximum" && ho.regular > ho.simplified) {
    add("c30", ho.regular, "Home office, regular method (Form 8829)");
    assumptions.push("Home office uses the regular method because it’s larger; it can’t create a loss and needs Form 8829.");
  } else add("c30", ho.simplified, "Home office, simplified method");

  // Phone, internet, fees.
  const ph = inputs.phone ?? {}, net = inputs.internet ?? {}, f = inputs.fees ?? {};
  add("c25", (n(ph.monthly) * 12 * n(ph.pct)) / 100, `Phone (${n(ph.pct)}% business)`);
  add("c25", (n(net.monthly) * 12 * n(net.pct)) / 100, `Internet (${n(net.pct)}% business)`);
  add("c10", n(f.platform) + n(f.payment), "Selling platform and payment processing fees");
  add("c18", n(f.software), "Software and subscriptions");
  add("c8", n(f.advertising), "Advertising");
  add("c27a", n(f.other), "Other business expenses");

  if (scenario !== "conservative") {
    const unset = lines.filter((l) => l.use_type === "mixed" && l.business_pct == null && l.tax_line !== "personal").length;
    if (unset) assumptions.push(`${unset} mixed-use item${unset === 1 ? " is" : "s are"} counted at 50% until you set the real business %.`);
  }

  const totals: Record<string, number> = {};
  for (const c of out) totals[c.line] = r2((totals[c.line] ?? 0) + c.amount);
  return { scenario, total: r2(Object.values(totals).reduce((a, b) => a + b, 0)), lines: totals, contributions: out, assumptions };
}

/* ---------------- missed write-offs ---------------- */

export interface Opportunity {
  id: string;
  kind: "action" | "tip" | "info";
  title: string;
  detail: string;
  value?: number; // estimated extra write-off
  action?:
    | { type: "categorize" }
    | { type: "describe" }
    | { type: "tab"; tab: "mileage" | "setup" }
    | { type: "items"; ids: string[]; fix?: Fix };
}

/** Bulk fixes the user can apply to a reviewed list of items. */
export type Fix = "cogs" | "business" | "confirm";
export const FIXES: Record<Fix, { label: string; patch: Record<string, unknown> }> = {
  cogs: { label: "Mark as inventory (COGS)", patch: { tax_line: "cogs", use_type: "business", tax_confidence: 1 } },
  business: { label: "Mark as business supplies", patch: { tax_line: "c22", use_type: "business", tax_confidence: 1 } },
  confirm: { label: "Confirm as categorized", patch: { tax_confidence: 1 } },
};

// Packing, shipping and office supplies. Kept specific: words like "bag", "paper" or "scale" match groceries and toys.
const BUSINESSY = /\b(shipping|packing|packaging|bubble ?(wrap|mailers?)|poly ?mailers?|mailers?|mailing|padded envelopes?|shipping labels?|thermal labels?|label printer|packing tape|shipping tape|box cutter|cardboard boxes|moving boxes|storage (bins?|totes?|containers?)|printer|toner|ink cartridges?|printer paper|copy paper|stapler|sharpie|post-?it|file folders?)\b/i;

const STOP = new Set(["the", "and", "with", "for", "pack", "count", "styles", "style", "may", "vary", "varies", "new", "set", "each", "size", "color", "colors", "assorted", "toy", "kids", "ages", "years", "old", "one", "piece"]);
const tokens = (text: string) =>
  new Set(text.toLowerCase().replace(/(\w)-(\w)/g, "$1$2").split(/[^a-z0-9:]+/).filter((t) => t.length >= 3 && !STOP.has(t)));

/** Words that show up across many of the user's inventory items (e.g. "wheels", "diecast", "1:64"). */
export function inventorySignature(lines: WLine[]): Set<string> {
  const inv = lines.filter((l) => l.tax_line === "cogs");
  const df = new Map<string, number>();
  for (const l of inv) for (const t of tokens(l.description)) df.set(t, (df.get(t) ?? 0) + 1);
  const min = Math.max(2, inv.length * 0.08);
  return new Set([...df].filter(([, c]) => c >= min).map(([t]) => t));
}

/** Items marked personal that share two or more signature words with the user's inventory. */
export function inventoryLookalikes(lines: WLine[]): WLine[] {
  const sig = inventorySignature(lines);
  if (sig.size < 2) return [];
  return lines.filter((l) => {
    if (l.tax_line !== "personal" && l.use_type !== "personal") return false;
    let hits = 0;
    for (const t of tokens(l.description)) if (sig.has(t)) hits++;
    return hits >= 2;
  });
}

export function findOpportunities(args: {
  year: number;
  lines: WLine[];
  trips: Trip[];
  suggested: SuggestedTrip[];
  inputs: YearInputs;
  storeMiles: Record<string, number>;
  hasBusinessDescription?: boolean;
}): Opportunity[] {
  const { year, lines, trips, suggested, inputs, storeMiles, hasBusinessDescription = true } = args;
  const rules = rulesFor(year);
  const ops: Opportunity[] = [];
  const sum = (ls: WLine[]) => r2(ls.reduce((a, l) => a + n(l.landed_total), 0));

  if (!hasBusinessDescription) ops.push({
    id: "describe", kind: "action",
    title: "Tell Claude what your business sells",
    detail: "Without it Claude has to guess what’s inventory, so items you resell can end up marked personal. Describe the business, then re-check your items.",
    action: { type: "describe" },
  });

  const lookalikes = inventoryLookalikes(lines);
  if (lookalikes.length) ops.push({
    id: "inventory-lookalikes", kind: "action", value: sum(lookalikes),
    title: `${plural(lookalikes.length, "item")} marked personal ${lookalikes.length === 1 ? "looks" : "look"} like your inventory`,
    detail: "They’re similar to items you’ve marked as inventory. If you bought them to resell, they belong in cost of goods sold. Review the list and untick any you kept.",
    action: { type: "items", ids: lookalikes.map((l) => l.id), fix: "cogs" },
  });

  const uncategorized = lines.filter((l) => !l.tax_line);
  if (uncategorized.length) ops.push({
    id: "uncategorized", kind: "action", value: sum(uncategorized.filter((l) => l.is_business)),
    title: `${plural(uncategorized.length, "item")} ${uncategorized.length === 1 ? "isn’t" : "aren’t"} categorized yet`,
    detail: `Claude can assign each one a Schedule C line and business/personal use. ${money(sum(uncategorized))} of purchases are waiting.`,
    action: { type: "categorize" },
  });

  const skuNotCogs = lines.filter((l) => l.woo_sku && l.tax_line && l.tax_line !== "cogs" && l.tax_line !== "personal");
  if (skuNotCogs.length) ops.push({
    id: "sku-not-cogs", kind: "action", value: 0,
    title: `${plural(skuNotCogs.length, "item")} with a Woo SKU ${skuNotCogs.length === 1 ? "isn’t" : "aren’t"} marked as inventory`,
    detail: "Items you resell belong in Cost of goods sold (Part III), not expenses. Set their tax line to “Inventory purchases (COGS)”.",
    action: { type: "items", ids: skuNotCogs.map((l) => l.id), fix: "cogs" },
  });

  const lookalikeIds = new Set(lookalikes.map((l) => l.id));
  const maybeBusiness = lines.filter((l) =>
    (l.tax_line === "personal" || l.use_type === "personal") && !lookalikeIds.has(l.id) && BUSINESSY.test(l.description));
  if (maybeBusiness.length) ops.push({
    id: "personal-businessy", kind: "action", value: sum(maybeBusiness),
    title: `${plural(maybeBusiness.length, "item")} marked personal ${maybeBusiness.length === 1 ? "looks" : "look"} like business supplies`,
    detail: "Packing, shipping, labels, storage and office items are deductible (Line 22 Supplies or Line 18 Office) when used for the shop. Mark them business if they were.",
    action: { type: "items", ids: maybeBusiness.map((l) => l.id), fix: "business" },
  });

  const mixedUnset = lines.filter((l) => l.use_type === "mixed" && l.business_pct == null && l.tax_line !== "personal");
  if (mixedUnset.length) ops.push({
    id: "mixed-unset", kind: "action", value: r2(sum(mixedUnset) / 2),
    title: `Set the business % on ${plural(mixedUnset.length, "mixed-use item")}`,
    detail: "Only the business share is deductible. Set a realistic % on each item’s receipt (e.g. a printer used 70% for the shop). Unset items count as 0% in the conservative scenario.",
    action: { type: "items", ids: mixedUnset.map((l) => l.id) },
  });

  const unsure = lines.filter((l) => l.tax_line && l.tax_line !== "personal" && l.tax_confidence != null && l.tax_confidence < 0.6);
  if (unsure.length) ops.push({
    id: "low-confidence", kind: "tip", value: sum(unsure),
    title: `Confirm ${plural(unsure.length, "item")} Claude wasn’t sure about`,
    detail: "Check the list (open any receipt to change its line) and confirm the rest. Confirmed items count in every scenario.",
    action: { type: "items", ids: unsure.map((l) => l.id), fix: "confirm" },
  });

  const equipment = lines.filter((l) => l.tax_line === "c13" && l.use_type !== "personal");
  const small = equipment.filter((l) => (l.unit_price ?? n(l.landed_total) / (n(l.quantity) || 1)) <= rules.deMinimis);
  if (small.length && !inputs.deMinimisElection) ops.push({
    id: "de-minimis", kind: "tip", value: sum(small),
    title: `Write off ${plural(small.length, "equipment item")} in full this year`,
    detail: `${small.length === 1 ? "It costs" : "Each costs"} $${rules.deMinimis.toLocaleString()} or less, so the de minimis safe harbor lets you deduct them now instead of depreciating. Attach the election statement (see How to claim) to your return.`,
    action: { type: "tab", tab: "setup" },
  });
  const big = equipment.filter((l) => !small.includes(l));
  if (big.length) ops.push({
    id: "section-179", kind: "tip", value: r2(sum(big) * 0.8),
    title: `${plural(big.length, "larger equipment purchase")} can be fully expensed`,
    detail: `With ${rules.bonusPct}% bonus depreciation or Section 179 (limit $${rules.section179.limit.toLocaleString()}), you can deduct the full cost in the year it’s placed in service instead of 20% — claim it on Form 4562.`,
  });

  const noMiles = suggested.filter((t) => !t.miles);
  const missingStores = [...new Set(noMiles.map((t) => t.merchant_key).filter((k): k is string => !!k && storeMiles[k] == null))];
  const unlogged = suggested.filter((t) => t.likelyInStore);
  if (unlogged.length) {
    const est = r2(unlogged.reduce((a, t) => a + tripValue({ trip_date: t.trip_date, miles: t.miles || 10 }), 0));
    ops.push({
      id: "mileage", kind: "action", value: est,
      title: `${plural(unlogged.length, "store trip")} ${unlogged.length === 1 ? "isn’t" : "aren’t"} in your mileage log`,
      detail: `Driving to buy inventory and supplies is deductible at ${rules.mileage.map((p) => `${p.cents}¢`).join(" / ")} a mile. ` +
        (missingStores.length ? `Enter your round-trip distance to ${missingStores.length} store${missingStores.length === 1 ? "" : "s"}, then add the trips.` : "Review and add them to your log.") +
        (rules.mileage.length > 1 ? " The rate changed mid-year, so each trip uses the rate for its date." : ""),
      action: { type: "tab", tab: "mileage" },
    });
  } else if (!trips.length) ops.push({
    id: "mileage-none", kind: "tip",
    title: "Log business driving",
    detail: "Trips to stores, the post office or suppliers are deductible. Add them in Mileage.",
    action: { type: "tab", tab: "mileage" },
  });

  const ho = inputs.homeOffice ?? {};
  if (!n(ho.sqft)) ops.push({
    id: "home-office", kind: "tip", value: rules.homeOffice.maxSqft * rules.homeOffice.ratePerSqft,
    title: "Claim your home office",
    detail: `If part of your home is used regularly and only for the business (packing, storing inventory, bookkeeping), deduct $${rules.homeOffice.ratePerSqft}/sq ft up to ${rules.homeOffice.maxSqft} sq ft — up to $${(rules.homeOffice.maxSqft * rules.homeOffice.ratePerSqft).toLocaleString()} — or the actual-cost share.`,
    action: { type: "tab", tab: "setup" },
  });
  if (!n(inputs.phone?.monthly) || !n(inputs.internet?.monthly)) ops.push({
    id: "phone-internet", kind: "tip",
    title: "Add the business share of your phone and internet",
    detail: "Enter your monthly bills and the % used for the business (listings, customer messages, orders).",
    action: { type: "tab", tab: "setup" },
  });
  const f = inputs.fees ?? {};
  if (!n(f.platform) && !n(f.payment)) ops.push({
    id: "fees", kind: "tip",
    title: "Add selling and payment fees",
    detail: "WooCommerce/Shopify/eBay fees, Stripe/PayPal/Square processing fees and shipping-label platform fees are deductible. Copy the year’s totals from each platform’s reports.",
    action: { type: "tab", tab: "setup" },
  });
  const hasInventory = lines.some((l) => l.tax_line === "cogs");
  if (hasInventory && inputs.inventory?.end == null) ops.push({
    id: "ending-inventory", kind: "action",
    title: "Enter your inventory on hand",
    detail: "Cost of goods sold is beginning inventory + purchases − ending inventory. Count unsold stock at cost on Dec 31; until then the estimate treats all purchases as sold.",
    action: { type: "tab", tab: "setup" },
  });
  ops.push({
    id: "qbi", kind: "info",
    title: `Qualified business income deduction (${rules.qbiPct}%)`,
    detail: "Most sole proprietors can also deduct up to 20% of business profit on Form 8995 — it’s not a Schedule C expense, so it isn’t in the totals here. Your tax software applies it.",
  });
  ops.push({
    id: "1099", kind: "info",
    title: `Paid a contractor $${rules.form1099Threshold.toLocaleString()}+?`,
    detail: `Send them a Form 1099-NEC (threshold for ${rules.year}: $${rules.form1099Threshold.toLocaleString()}). Contract labor is deductible on Line 11.`,
  });
  return ops;
}

function money(v: number) {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---------------- how to claim ---------------- */

export interface Direction {
  line: string;
  title: string;
  steps: string[];
  records: string;
  source: string;
}

export function directions(year: number): Direction[] {
  const r = rulesFor(year);
  const rates = r.mileage.map((p) => `${p.cents}¢ (${p.from.slice(5)} to ${p.to.slice(5)})`).join(", ");
  return [
    {
      line: "cogs", title: "Inventory you resell → Cost of goods sold (Schedule C, Part III)",
      steps: [
        "Line 35: inventory at cost on Jan 1 (last year’s ending number).",
        "Line 36: purchases for the year — the Inventory & COGS total (landed: includes tax and shipping).",
        "Line 41: inventory at cost on Dec 31. Count unsold stock and value it at what you paid.",
        "Line 42 (COGS) = 35 + 36 − 41. Unsold inventory isn’t deductible until it sells.",
      ],
      records: "Receipts for every purchase and a year-end count sheet (SKU, units, unit cost).",
      source: SOURCES.PUB334,
    },
    {
      line: "c9", title: "Driving → Line 9 Car and truck expenses",
      steps: [
        `Multiply business miles by the standard rate: ${rates}.`,
        "Also deductible on top: business parking and tolls.",
        "Use the standard rate in the first year you use a car for business to keep the option to switch later.",
        "Commuting doesn’t count, but trips from your home office to stores, suppliers and the post office do.",
      ],
      records: "A mileage log with date, destination, business purpose and miles — export it from Mileage. Note your odometer on Jan 1 and Dec 31.",
      source: SOURCES.PUB463,
    },
    {
      line: "c22", title: "Supplies → Line 22 · Office → Line 18",
      steps: [
        "Packing and shipping materials, labels, tape and display supplies go on Line 22.",
        "Office supplies, software and small office items go on Line 18.",
        "Postage and shipping labels you pay for go on Line 27a (other expenses).",
      ],
      records: "Itemized receipts — they’re already saved here.",
      source: SOURCES.PUB535,
    },
    {
      line: "c13", title: "Equipment → write it off now",
      steps: [
        `Items up to $${r.deMinimis.toLocaleString()} each: deduct in full as supplies using the de minimis safe harbor. Attach this statement to your return: “Section 1.263(a)-1(f) de minimis safe harbor election. [Name], [Address], [SSN or EIN]. The taxpayer is making the de minimis safe harbor election for the tax year ending December 31, ${r.year}.”`,
        `Bigger items (computers, shelving, a vehicle): elect Section 179 (limit $${r.section179.limit.toLocaleString()}) or take ${r.bonusPct}% bonus depreciation on Form 4562, Part I/II. The item must be placed in service this year.`,
        "In a low-income year you can instead depreciate over 5–7 years to save deductions for later.",
      ],
      records: "Receipt, date placed in service and business-use %.",
      source: SOURCES.TANGIBLE,
    },
    {
      line: "c30", title: "Home office → Line 30",
      steps: [
        `Simplified: $${r.homeOffice.ratePerSqft} × office sq ft (max ${r.homeOffice.maxSqft}) — no Form 8829.`,
        "Regular: office sq ft ÷ home sq ft × rent (or mortgage interest), utilities, insurance and repairs — Form 8829. Can’t create a loss.",
        "The space must be used regularly and only for the business (a storage room for inventory counts).",
      ],
      records: "A floor sketch with measurements, photos of the space, and the year’s home bills.",
      source: SOURCES.PUB587,
    },
    {
      line: "c25", title: "Phone and internet → Line 25 Utilities",
      steps: ["Deduct the business share of your monthly bills (e.g. 40% of a $90 phone bill = $432/yr).", "Keep the % realistic and the same all year."],
      records: "Bills and a note of how you worked out the %.",
      source: SOURCES.PUB535,
    },
    {
      line: "c10", title: "Selling and payment fees → Line 10 Commissions and fees",
      steps: ["Add marketplace, store-platform and card-processing fees for the year from each platform’s annual report.", "If gross sales are reported to you net of fees, report the gross sales and deduct the fees here."],
      records: "Annual fee reports or 1099-K statements from each platform.",
      source: SOURCES.PUB334,
    },
    {
      line: "c24b", title: "Business meals → Line 24b",
      steps: [`Only ${r.mealsPct}% is deductible.`, "Write who you met and the business purpose on the receipt."],
      records: "Receipt plus attendee and purpose.",
      source: SOURCES.PUB463,
    },
    {
      line: "gifts", title: "Gifts to customers",
      steps: [`Deduct up to $${r.giftLimit} per person per year (Line 27a). Promotional items with your logo under $4 don’t count toward the limit.`],
      records: "Receipt and who received it.",
      source: SOURCES.PUB463,
    },
  ];
}
