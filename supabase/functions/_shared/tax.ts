// IRS Schedule C lines used for categorization. Keep in sync with web/src/lib/tax.ts.
// Guidance only — the user (or their accountant) has the final say.
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
  c27a: "Line 27a · Other expenses (postage, software, fees…)",
  personal: "Personal · not deductible",
};

export const TAX_LINE_CODES = Object.keys(TAX_LINES);
export const USE_TYPES = ["business", "personal", "mixed"] as const;

export const TAX_GUIDANCE = `Tax categorization (US Schedule C), per line item:
- tax_line: one code from this list:
${Object.entries(TAX_LINES).map(([k, v]) => `  ${k} = ${v}`).join("\n")}
- Use "cogs" only for goods bought to resell (inventory). Packaging that ships with sold goods (mailers, boxes, tape) is "c22". Postage and shipping labels are "c27a".
- use_type: "business", "personal" or "mixed". Personal items get tax_line "personal".
- tax_confidence: 0 to 1. Be honest; ambiguous items should be below 0.6.
- Use the business description, if given, to decide what counts as inventory or a business expense.`;
