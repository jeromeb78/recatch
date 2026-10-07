// Tools exposed to Claude. Every query is scoped to the authenticated user's id.
import { ingest, pageMessageId } from "../_shared/ingest.ts";
import { TAX_LINE_CODES, TAX_LINES, USE_TYPES } from "../_shared/tax.ts";
import { adminClient, sha256Hex } from "../_shared/utils.ts";
import { appUrl } from "./oauth.ts";

type Args = Record<string, unknown>;
type Handler = (userId: string, args: Args) => Promise<unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
  handler: Handler;
}

const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const clampInt = (v: unknown, def: number, max: number) => Math.min(Math.max(Math.floor(Number(v) || def), 1), max);
const r2 = (n: number) => Math.round(n * 100) / 100;
const receiptLink = (id: string) => `${appUrl()}/receipts/${id}`;

class ToolError extends Error {}

function parseUrl(v: unknown): URL | undefined {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------- write tools ---------------- */

const addReceipt: Handler = async (userId, a) => {
  const text = typeof a.text === "string" ? a.text : "";
  if (text.trim().length < 40) throw new ToolError("Pass the full text of the receipt or order page (at least a few lines).");
  const url = a.source_url !== undefined ? parseUrl(a.source_url) : undefined;
  if (a.source_url !== undefined && !url) throw new ToolError("source_url must be an https URL.");

  const result = await ingest({
    userId,
    source: "claude",
    messageId: url ? pageMessageId(url) : `claude:${(await sha256Hex(text.trim())).slice(0, 32)}`,
    subject: str(a.title, 300),
    from: url?.hostname ?? "Claude",
    text: text.slice(0, 400_000),
    sourceUrl: url?.toString(),
    rawName: "page",
  });
  return "receiptId" in result && result.receiptId ? { ...result, link: receiptLink(result.receiptId) } : result;
};

const checkImported: Handler = async (userId, a) => {
  const urls = (Array.isArray(a.urls) ? a.urls : []).slice(0, 200).map(parseUrl).filter((u): u is URL => !!u);
  if (!urls.length) throw new ToolError("Pass one or more https order URLs in `urls`.");
  const ids = urls.map(pageMessageId);
  const { data, error } = await adminClient().from("receipts").select("source_message_id")
    .eq("user_id", userId).in("source_message_id", ids);
  if (error) throw error;
  const have = new Set((data ?? []).map((r) => r.source_message_id));
  return {
    already_imported: urls.filter((u, i) => have.has(ids[i])).map(String),
    not_imported: urls.filter((u, i) => !have.has(ids[i])).map(String),
  };
};

const updateLineItem: Handler = async (userId, a) => {
  const id = str(a.id, 64);
  if (!id) throw new ToolError("id is required (from get_receipt).");
  const patch: Record<string, unknown> = {};
  if (a.woo_sku !== undefined) patch.woo_sku = str(a.woo_sku, 100) ?? null;
  if (a.tax_line !== undefined) {
    if (!TAX_LINE_CODES.includes(String(a.tax_line))) throw new ToolError(`tax_line must be one of ${TAX_LINE_CODES.join(", ")}`);
    patch.tax_line = a.tax_line;
    patch.tax_confidence = 1;
  }
  if (a.use_type !== undefined) {
    if (!(USE_TYPES as readonly string[]).includes(String(a.use_type))) throw new ToolError("use_type must be business, personal or mixed");
    patch.use_type = a.use_type;
  }
  if (a.pack_size !== undefined) patch.pack_size = clampInt(a.pack_size, 1, 10000);
  if (!Object.keys(patch).length) throw new ToolError("Nothing to update: pass woo_sku, tax_line, use_type or pack_size.");

  const { data, error } = await adminClient().from("line_items").update(patch)
    .eq("id", id).eq("user_id", userId)
    .select("id, receipt_id, description, woo_sku, tax_line, use_type, pack_size, quantity, total").maybeSingle();
  if (error) throw error;
  if (!data) throw new ToolError("Line item not found.");
  return data;
};

/* ---------------- read tools ---------------- */

const searchReceipts: Handler = async (userId, a) => {
  let q = adminClient().from("receipts")
    .select("id, purchase_date, merchant, order_number, total, currency, status, review_reasons, document_type, source, category:categories(name)")
    .eq("user_id", userId)
    .order("purchase_date", { ascending: false, nullsFirst: false })
    .limit(clampInt(a.limit, 20, 100));
  const term = str(a.query, 100)?.replace(/[,()*%\\]/g, " ").trim();
  if (term) q = q.or(`merchant.ilike.*${term}*,order_number.ilike.*${term}*,items_text.ilike.*${term}*`);
  const merchant = str(a.merchant, 100);
  if (merchant) q = q.ilike("merchant", `%${merchant.replace(/[%_\\]/g, "")}%`);
  if (date(a.from)) q = q.gte("purchase_date", date(a.from)!);
  if (date(a.to)) q = q.lte("purchase_date", date(a.to)!);
  if (a.status === "needs_review" || a.status === "ready") q = q.eq("status", a.status);
  const { data, error } = await q;
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const receipts = (data ?? []).map((r: any) => ({ ...r, category: r.category?.name ?? null, link: receiptLink(r.id) }));
  return { count: receipts.length, receipts };
};

const getReceipt: Handler = async (userId, a) => {
  const id = str(a.id, 64);
  if (!id) throw new ToolError("id is required.");
  const db = adminClient();
  const { data: r, error } = await db.from("receipts")
    .select("id, purchase_date, merchant, order_number, subtotal, tax, shipping, discount, total, currency, payment_method, status, review_reasons, document_type, source, source_url, notes, category:categories(name)")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!r) throw new ToolError("Receipt not found.");
  const { data: items } = await db.from("line_items")
    .select("id, position, description, store_sku, woo_sku, quantity, pack_size, unit_price, total, tax_line, use_type, tax_confidence")
    .eq("receipt_id", id).eq("user_id", userId).order("position");
  // deno-lint-ignore no-explicit-any
  return { ...r, category: (r as any).category?.name ?? null, line_items: items ?? [], link: receiptLink(id) };
};

const spendingSummary: Handler = async (userId, a) => {
  const from = date(a.from), to = date(a.to);
  const groupBy = ["merchant", "category", "tax_line", "month"].includes(String(a.group_by)) ? String(a.group_by) : "merchant";
  const db = adminClient();
  const groups = new Map<string, { total: number; count: number }>();
  const add = (k: string, v: number) => {
    const g = groups.get(k) ?? { total: 0, count: 0 };
    g.total += v;
    g.count++;
    groups.set(k, g);
  };

  if (groupBy === "tax_line") {
    let q = db.from("inventory_lines").select("tax_line, use_type, landed_total").eq("user_id", userId).limit(10000);
    if (from) q = q.gte("purchase_date", from);
    if (to) q = q.lte("purchase_date", to);
    const { data, error } = await q;
    if (error) throw error;
    for (const l of data ?? []) {
      if (a.business_only && (l.use_type === "personal" || l.tax_line === "personal")) continue;
      add(l.tax_line ? `${TAX_LINES[l.tax_line] ?? l.tax_line}` : "Not categorized", Number(l.landed_total ?? 0));
    }
  } else {
    let q = db.from("receipts").select("purchase_date, merchant, total, document_type, category:categories(name, is_business)")
      .eq("user_id", userId).limit(10000);
    if (from) q = q.gte("purchase_date", from);
    if (to) q = q.lte("purchase_date", to);
    const { data, error } = await q;
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    for (const r of (data ?? []) as any[]) {
      if (a.business_only && !r.category?.is_business) continue;
      const v = Number(r.total ?? 0) * (r.document_type === "refund" ? -1 : 1);
      const key = groupBy === "merchant" ? r.merchant ?? "Unknown"
        : groupBy === "category" ? r.category?.name ?? "Uncategorized"
        : (r.purchase_date ?? "unknown").slice(0, 7);
      add(key, v);
    }
  }

  const rows = [...groups.entries()].map(([key, g]) => ({ [groupBy]: key, total: r2(g.total), count: g.count }));
  rows.sort((x, y) => groupBy === "month" ? String(x.month).localeCompare(String(y.month)) : y.total - x.total);
  return { from: from ?? null, to: to ?? null, group_by: groupBy, total: r2(rows.reduce((s, r) => s + r.total, 0)), groups: rows };
};

const inventoryCosts: Handler = async (userId, a) => {
  let q = adminClient().from("inventory_lines")
    .select("description, woo_sku, units, landed_total, purchase_date, merchant, tax_line")
    .eq("user_id", userId).limit(10000);
  if (date(a.from)) q = q.gte("purchase_date", date(a.from)!);
  if (date(a.to)) q = q.lte("purchase_date", date(a.to)!);
  const sku = str(a.sku, 100);
  if (sku) q = q.eq("woo_sku", sku);
  const { data, error } = await q;
  if (error) throw error;

  const lines = (data ?? []).filter((l) => l.woo_sku || l.tax_line === "cogs");
  const by = new Map<string, typeof lines>();
  for (const l of lines) if (l.woo_sku) by.set(l.woo_sku, [...(by.get(l.woo_sku) ?? []), l]);
  const term = str(a.query, 100)?.toLowerCase();
  const skus = [...by.entries()].map(([s, ls]) => {
    const units = ls.reduce((x, l) => x + Number(l.units), 0);
    const spend = ls.reduce((x, l) => x + Number(l.landed_total ?? 0), 0);
    const last = [...ls].sort((x, y) => (y.purchase_date ?? "").localeCompare(x.purchase_date ?? ""))[0];
    return {
      sku: s,
      item: last.description,
      units,
      spend: r2(spend),
      avg_unit_cost: units ? r2(spend / units) : null,
      last_unit_cost: Number(last.units) ? r2(Number(last.landed_total ?? 0) / Number(last.units)) : null,
      last_purchased: last.purchase_date,
      stores: [...new Set(ls.map((l) => l.merchant).filter(Boolean))],
    };
  }).filter((s) => !term || `${s.sku} ${s.item} ${s.stores.join(" ")}`.toLowerCase().includes(term))
    .sort((x, y) => y.spend - x.spend)
    .slice(0, clampInt(a.limit, 50, 500));

  const unmapped = lines.filter((l) => !l.woo_sku);
  return {
    note: "Costs are landed (order tax, shipping and discounts spread across items); units count pack sizes.",
    skus,
    unmapped_inventory_items: { count: unmapped.length, spend: r2(unmapped.reduce((x, l) => x + Number(l.landed_total ?? 0), 0)) },
  };
};

/* ---------------- registry ---------------- */

const READ = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: Tool[] = [
  {
    name: "add_receipt",
    title: "Add a receipt",
    description:
      "Capture a purchase from the text of a store order-details page, invoice, receipt or receipt email. " +
      "Pass the page's full visible text (not a summary) and its URL when there is one. Receipt Catcher extracts " +
      "the merchant, date, totals and line items itself and skips orders it already has.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Full visible text of the order/receipt page or email." },
        source_url: { type: "string", description: "https URL of the order page, used to avoid duplicates." },
        title: { type: "string", description: "Page or email title." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "Add a receipt", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: addReceipt,
  },
  {
    name: "check_imported",
    title: "Check which orders are already imported",
    description: "Given order-page URLs (e.g. from a Walmart, Target or Amazon order history page), returns which are already in Receipt Catcher, so only new ones need opening.",
    inputSchema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" }, maxItems: 200 } },
      required: ["urls"],
      additionalProperties: false,
    },
    annotations: { title: "Check imported orders", ...READ },
    handler: checkImported,
  },
  {
    name: "search_receipts",
    title: "Search receipts",
    description: "Find receipts by store, order number, item text, date range or review status. Dates are YYYY-MM-DD.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Matches merchant, order number or line-item text." },
        merchant: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        status: { type: "string", enum: ["ready", "needs_review"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Search receipts", ...READ },
    handler: searchReceipts,
  },
  {
    name: "get_receipt",
    title: "Get a receipt",
    description: "Full details of one receipt, including line items with their ids, Woo SKUs, pack sizes and tax lines.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    annotations: { title: "Get a receipt", ...READ },
    handler: getReceipt,
  },
  {
    name: "spending_summary",
    title: "Spending summary",
    description: "Total spend for a date range grouped by merchant, category, Schedule C tax line or month. Refunds count as negative.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        group_by: { type: "string", enum: ["merchant", "category", "tax_line", "month"] },
        business_only: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { title: "Spending summary", ...READ },
    handler: spendingSummary,
  },
  {
    name: "inventory_costs",
    title: "Inventory costs by SKU",
    description: "Units bought, spend, average and latest landed cost per unit for each Woo SKU, plus inventory items not yet mapped to a SKU.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        query: { type: "string", description: "Filter by SKU, item name or store." },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Inventory costs", ...READ },
    handler: inventoryCosts,
  },
  {
    name: "update_line_item",
    title: "Update a line item",
    description: "Set a line item's Woo SKU, Schedule C tax line, business/personal use or pack size (units per item, e.g. 24 for a 24-count case). Get line item ids from get_receipt.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        woo_sku: { type: "string" },
        tax_line: { type: "string", enum: TAX_LINE_CODES },
        use_type: { type: "string", enum: [...USE_TYPES] },
        pack_size: { type: "integer", minimum: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "Update a line item", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: updateLineItem,
  },
];

export async function callTool(name: string, userId: string, args: Args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const data = await tool.handler(userId, args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `Receipt Catcher error: ${e instanceof Error ? e.message : String(e)}`;
    if (!(e instanceof ToolError)) console.error("mcp tool", name, e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

