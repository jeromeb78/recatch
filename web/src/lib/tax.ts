// Keep in sync with supabase/functions/_shared/tax.ts.
export const TAX_LINES: Record<string, string> = {
  cogs: "Part III · Inventory purchases (COGS)",
  c8: "Line 8 · Advertising",
  c9: "Line 9 · Car and truck expenses",
  c13: "Line 13 · Depreciation / Section 179 equipment",
  c15: "Line 15 · Insurance",
  c17: "Line 17 · Legal and professional services",
  c18: "Line 18 · Office expense",
  c20b: "Line 20b · Rent or lease (other property)",
  c21: "Line 21 · Repairs and maintenance",
  c22: "Line 22 · Supplies",
  c23: "Line 23 · Taxes and licenses",
  c24a: "Line 24a · Travel",
  c24b: "Line 24b · Meals",
  c25: "Line 25 · Utilities",
  c27a: "Line 27a · Other expenses",
  personal: "Personal · not deductible",
};

/** Short label for chips: "Line 22 · Supplies" → "Supplies". */
export function taxShort(code: string | null | undefined): string {
  if (!code) return "Uncategorized";
  const label = TAX_LINES[code] ?? code;
  return label.split(" · ")[1] ?? label;
}

export const USE_LABEL: Record<string, string> = { business: "Business", personal: "Personal", mixed: "Mixed" };
