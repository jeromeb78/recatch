// Fills in Schedule C line / business-vs-personal for line items.
// POST (user JWT); any body may include account: owner id when working in an account the caller was invited to,
// and business: a business id to work on only that business's items.
//   { limit?: number }                      → items with no tax line yet → { categorized, remaining }
//   { recheck: true, after?: id, limit? }   → re-run items marked personal or low-confidence (not hand-edited),
//                                             e.g. after the business description changes → { categorized, next }
// Each item is categorized with the description of the business it belongs to (its own, else its receipt's),
// falling back to the account's general business description.
import { categorizeItems } from "../_shared/categorize.ts";
import { accountFor, adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";

const BATCH = 50;
const ENTITY: Record<string, string> = {
  sole_prop: "sole proprietorship (Schedule C)", single_llc: "single-member LLC (Schedule C)", partnership: "partnership",
  s_corp: "S corporation", c_corp: "C corporation", other: "business",
};

interface Business { id: string; name: string; entity_type: string; description: string | null }

export function businessContext(b: Business | undefined, fallback: string | null): string | null {
  if (!b) return fallback;
  const what = b.description?.trim() || fallback?.trim() || "";
  return `${b.name} — a ${ENTITY[b.entity_type] ?? "business"}${what ? `. ${what}` : ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await userFromRequest(req);
  if (!caller) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();

  try {
    const body = await req.json().catch(() => ({}));
    const owner = await accountFor(caller, body?.account, "reports", "edit");
    if (!owner) return json({ error: "You don't have permission to edit tax categories in this account" }, 403);
    const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 200);
    const recheck = body?.recheck === true;
    const only = typeof body?.business === "string" ? body.business : null;

    const [{ data: profile }, { data: businesses }] = await Promise.all([
      db.from("profiles").select("business_description").eq("user_id", owner).maybeSingle(),
      db.from("businesses").select("id, name, entity_type, description").eq("user_id", owner),
    ]);
    const byId = new Map(((businesses ?? []) as Business[]).map((b) => [b.id, b]));
    if (only && !byId.has(only)) return json({ error: "Unknown business" }, 400);

    // inventory_lines resolves each item's business (its own, else its receipt's).
    let q = db.from("inventory_lines").select("id, description, item_total, merchant, category, business_id").eq("user_id", owner);
    if (only) q = q.eq("business_id", only);
    if (recheck) {
      // Hand-edited items have confidence 1 and are left alone.
      q = q.or("tax_line.eq.personal,tax_confidence.lt.0.6").order("id").limit(limit);
      if (typeof body?.after === "string") q = q.gt("id", body.after);
    } else {
      q = q.is("tax_line", null).order("purchase_date", { ascending: false }).limit(limit);
    }
    const { data: rows, error } = await q;
    if (error) throw error;

    // One model call per business context, in batches.
    const groups = new Map<string, typeof rows>();
    for (const r of rows ?? []) {
      const key = r.business_id ?? "";
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let categorized = 0;
    for (const [bid, items] of groups) {
      const context = businessContext(byId.get(bid), profile?.business_description ?? null);
      for (let i = 0; i < items!.length; i += BATCH) {
        const batch = items!.slice(i, i + BATCH).map((r) => ({
          id: r.id, description: r.description, merchant: r.merchant ?? null, category: r.category ?? null, total: r.item_total,
        }));
        const results = await categorizeItems(batch, context);
        for (const c of results) {
          const { error } = await db.from("line_items").update({
            tax_line: c.tax_line,
            use_type: c.use_type,
            tax_confidence: Math.max(0, Math.min(1, c.tax_confidence)),
          }).eq("id", c.id).eq("user_id", owner);
          if (!error) categorized++;
        }
      }
    }

    if (recheck) {
      const last = rows?.length === limit ? rows[rows.length - 1].id : null;
      return json({ categorized, next: last });
    }
    let rq = db.from("inventory_lines").select("id", { count: "exact", head: true }).eq("user_id", owner).is("tax_line", null);
    if (only) rq = rq.eq("business_id", only);
    const { count } = await rq;
    return json({ categorized, remaining: count ?? 0 });
  } catch (e) {
    console.error("categorize-items", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
