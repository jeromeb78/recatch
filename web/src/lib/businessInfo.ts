// Pure business helpers (no React/Supabase), shared by the app and tests.

export type EntityType = "sole_prop" | "single_llc" | "partnership" | "s_corp" | "c_corp" | "other";


export const ENTITY_LABEL: Record<EntityType, string> = {
  sole_prop: "Sole proprietorship",
  single_llc: "Single-member LLC",
  partnership: "Partnership / multi-member LLC",
  s_corp: "S corporation",
  c_corp: "C corporation",
  other: "Other",
};

/** Which return a business's expenses go on — write-offs here follow Schedule C. */
export const ENTITY_FORM: Record<EntityType, string> = {
  sole_prop: "Schedule C (Form 1040)",
  single_llc: "Schedule C (Form 1040)",
  partnership: "Form 1065",
  s_corp: "Form 1120-S",
  c_corp: "Form 1120",
  other: "",
};

export const usesScheduleC = (b: { entity_type: EntityType }) => b.entity_type === "sole_prop" || b.entity_type === "single_llc";

/** "4242, Visa 1881" → ["4242", "1881"]. Cards are separated by commas; only the last 4 digits are kept,
 *  so a full card number typed by mistake is never stored. */
export function parseCards(text: string): string[] {
  return [...new Set(text.split(/[,;\n]+/).map((t) => t.replace(/\D/g, "").slice(-4)).filter((t) => t.length === 4))];
}

export function parseStores(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
}
