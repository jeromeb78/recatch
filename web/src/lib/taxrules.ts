// US federal figures for self-employed (Schedule C) write-offs, by tax year.
// Each figure cites its IRS source. Update this file once a year when the IRS publishes the new numbers
// (usually Oct–Dec: inflation adjustments, mileage rates) and bump `verified`.

export interface MileagePeriod {
  from: string; // inclusive, YYYY-MM-DD
  to: string; // inclusive
  cents: number;
}

export interface TaxYearRules {
  year: number;
  verified: string;
  mileage: MileagePeriod[];
  mileageSource: string;
  /** De minimis safe harbor: deduct items up to this cost each in full (taxpayers without audited statements). */
  deMinimis: number;
  section179: { limit: number; phaseOut: number };
  /** Bonus (additional first-year) depreciation, % of cost. */
  bonusPct: number;
  depreciationSource: string;
  mealsPct: number;
  giftLimit: number;
  homeOffice: { ratePerSqft: number; maxSqft: number };
  startupCosts: { deduct: number; phaseOutStart: number };
  qbiPct: number;
  /** Payments to one contractor at or above this need a Form 1099-NEC. */
  form1099Threshold: number;
  notes: string[];
}

const PUB463 = "https://www.irs.gov/publications/p463";
const PUB587 = "https://www.irs.gov/publications/p587";
const PUB946 = "https://www.irs.gov/publications/p946";
const PUB334 = "https://www.irs.gov/publications/p334";
const PUB535 = "https://www.irs.gov/publications/p535";
const TANGIBLE = "https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations";

export const SOURCES = { PUB463, PUB587, PUB946, PUB334, PUB535, TANGIBLE };

export const TAX_RULES: Record<number, TaxYearRules> = {
  2024: {
    year: 2024,
    verified: "2026-10-13",
    mileage: [{ from: "2024-01-01", to: "2024-12-31", cents: 67 }],
    mileageSource: "https://www.irs.gov/tax-professionals/standard-mileage-rates",
    deMinimis: 2500,
    section179: { limit: 1_220_000, phaseOut: 3_050_000 },
    bonusPct: 60,
    depreciationSource: PUB946,
    mealsPct: 50,
    giftLimit: 25,
    homeOffice: { ratePerSqft: 5, maxSqft: 300 },
    startupCosts: { deduct: 5000, phaseOutStart: 50_000 },
    qbiPct: 20,
    form1099Threshold: 600,
    notes: [],
  },
  2025: {
    year: 2025,
    verified: "2026-10-13",
    mileage: [{ from: "2025-01-01", to: "2025-12-31", cents: 70 }],
    mileageSource: "https://www.irs.gov/tax-professionals/standard-mileage-rates",
    deMinimis: 2500,
    section179: { limit: 2_500_000, phaseOut: 4_000_000 },
    bonusPct: 100,
    depreciationSource: PUB946,
    mealsPct: 50,
    giftLimit: 25,
    homeOffice: { ratePerSqft: 5, maxSqft: 300 },
    startupCosts: { deduct: 5000, phaseOutStart: 50_000 },
    qbiPct: 20,
    form1099Threshold: 600,
    notes: [
      "The 2025 tax law (P.L. 119-21) raised Section 179 to $2.5M and restored 100% bonus depreciation for property acquired after Jan 19, 2025 (40% before that date).",
    ],
  },
  2026: {
    year: 2026,
    verified: "2026-10-13",
    mileage: [
      { from: "2026-01-01", to: "2026-06-30", cents: 72.5 },
      { from: "2026-07-01", to: "2026-12-31", cents: 76 },
    ],
    mileageSource: "https://www.irs.gov/tax-professionals/standard-mileage-rates",
    deMinimis: 2500,
    section179: { limit: 2_560_000, phaseOut: 4_090_000 },
    bonusPct: 100,
    depreciationSource: PUB946,
    mealsPct: 50,
    giftLimit: 25,
    homeOffice: { ratePerSqft: 5, maxSqft: 300 },
    startupCosts: { deduct: 5000, phaseOutStart: 50_000 },
    qbiPct: 20,
    form1099Threshold: 2000,
    notes: [
      "The IRS raised the business mileage rate mid-year: 72.5¢ through June 30, 76¢ from July 1, 2026.",
      "Form 1099-NEC is now required only for payments of $2,000 or more to one contractor (was $600).",
      "The 20% qualified business income (QBI) deduction is now permanent.",
    ],
  },
};

export const RULE_YEARS = Object.keys(TAX_RULES).map(Number).sort();

/** Rules for a tax year; years after the newest known year use the newest figures (flagged by `isEstimate`). */
export function rulesFor(year: number): TaxYearRules & { isEstimate: boolean } {
  const known = TAX_RULES[year];
  if (known) return { ...known, isEstimate: false };
  const latest = RULE_YEARS.filter((y) => y <= year).pop() ?? RULE_YEARS[0];
  return { ...TAX_RULES[latest], year, isEstimate: true };
}

/** Standard mileage rate (dollars per mile) on a given date. */
export function mileageRate(date: string): number {
  const rules = rulesFor(Number(date.slice(0, 4)));
  const period = rules.mileage.find((p) => date >= p.from && date <= p.to) ?? rules.mileage[rules.mileage.length - 1];
  return period.cents / 100;
}
