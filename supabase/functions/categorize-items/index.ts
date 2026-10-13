// Fills in Schedule C line / business-vs-personal for line items.
// POST (user JWT)
//   { limit?: number }                      → items with no tax line yet → { categorized, remaining }
//   { recheck: true, after?: id, limit? }   → re-run items marked personal or low-confidence (not hand-edited),
//                                             e.g. after the business description changes → { categorized, next }
import { categorizeItems } from "../_shared/categorize.ts";
import { adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";

const BATCH = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();

  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 200);
    const recheck = body?.recheck === true;

    const { data: profile } = await db.from("profiles").select("business_description").eq("user_id", user.id).maybeSingle();
    let q = db
      .from("line_items")
      .select("id, description, total, category:categories(name), receipt:receipts(merchant, category:categories(name))")
      .eq("user_id", user.id);
    if (recheck) {
      // Hand-edited items have confidence 1 and are left alone.
      q = q.or("tax_line.eq.personal,tax_confidence.lt.0.6").order("id").limit(limit);
      if (typeof body?.after === "string") q = q.gt("id", body.after);
    } else {
      q = q.is("tax_line", null).order("created_at", { ascending: false }).limit(limit);
    }
    const { data: rows, error } = await q;
    if (error) throw error;

    let categorized = 0;
    for (let i = 0; i < (rows ?? []).length; i += BATCH) {
      // deno-lint-ignore no-explicit-any
      const batch = (rows ?? []).slice(i, i + BATCH).map((r: any) => ({
        id: r.id,
        description: r.description,
        merchant: r.receipt?.merchant ?? null,
        category: r.category?.name ?? r.receipt?.category?.name ?? null,
        total: r.total,
      }));
      const results = await categorizeItems(batch, profile?.business_description ?? null);
      for (const c of results) {
        const { error } = await db.from("line_items").update({
          tax_line: c.tax_line,
          use_type: c.use_type,
          tax_confidence: Math.max(0, Math.min(1, c.tax_confidence)),
        }).eq("id", c.id).eq("user_id", user.id);
        if (!error) categorized++;
      }
    }

    if (recheck) {
      const last = rows?.length === limit ? rows[rows.length - 1].id : null;
      return json({ categorized, next: last });
    }
    const { count } = await db.from("line_items").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).is("tax_line", null);
    return json({ categorized, remaining: count ?? 0 });
  } catch (e) {
    console.error("categorize-items", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
