import { Extraction, extractReceipt } from "./extract.ts";
import { adminClient, htmlToText, safeFilename } from "./utils.ts";

export interface RawFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface IngestInput {
  userId: string;
  source: "gmail" | "forward" | "upload" | "extension" | "claude";
  /** Dedupe key: Gmail message id, Postmark MessageID, or upload path. */
  messageId?: string;
  connectionId?: string;
  subject?: string;
  from?: string;
  date?: string;
  text?: string;
  html?: string;
  pdfs?: RawFile[];
  images?: RawFile[];
  /** Files already in storage (uploads) — recorded but not re-uploaded. */
  existingFiles?: { path: string; mime: string; name: string }[];
  /** Don't copy pdfs/images to storage (they're already there). */
  skipStore?: boolean;
  /** Web page the receipt came from (browser extension). */
  sourceUrl?: string;
  /** File name for the stored original text/html (default email.*). */
  rawName?: string;
}

export type IngestOutcome =
  | { outcome: "receipt"; receiptId: string; status: string }
  | { outcome: "duplicate"; receiptId?: string; detail: string }
  | { outcome: "skipped"; detail: string };

const BUCKET = "receipts";
const NON_RECEIPT_TYPES = new Set(["shipping_notice", "other"]);

/** Stable id for a store order page, shared by the browser extension and the Claude connector. */
export function pageMessageId(url: URL): string {
  const id = url.searchParams.get("orderID") ?? url.searchParams.get("orderId");
  const key = id ?? (url.pathname.split("/").filter(Boolean).slice(-2).join("/") || url.pathname);
  return `ext:${url.hostname}:${key}`;
}

export function merchantKey(merchant: string | null): string | null {
  const k = (merchant ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return k || null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineTotal(li: Extraction["line_items"][number]): number | null {
  if (li.total != null) return li.total;
  if (li.unit_price != null) return round2(li.unit_price * (li.quantity ?? 1));
  return null;
}

export function reviewReasons(x: Extraction, truncated: boolean): string[] {
  const reasons: string[] = [];
  if (x.confidence < 0.75) reasons.push("Low confidence");
  if (x.total == null) reasons.push("Missing total");
  if (!x.purchase_date) reasons.push("Missing date");
  if (truncated) reasons.push("Email was very long; only the first part was read");

  const totals = x.line_items.map(lineTotal);
  if (totals.length && totals.every((t) => t != null)) {
    const sum = round2(totals.reduce((a, b) => a! + b!, 0)!);
    if (x.subtotal != null) {
      if (Math.abs(sum - x.subtotal) > Math.max(0.05, x.subtotal * 0.01)) {
        reasons.push(`Line items add up to ${sum.toFixed(2)}, subtotal is ${x.subtotal.toFixed(2)}`);
      }
    } else if (x.total != null) {
      const expected = round2(sum + (x.tax ?? 0) + (x.shipping ?? 0) - (x.discount ?? 0));
      if (Math.abs(expected - x.total) > Math.max(0.05, x.total * 0.01)) {
        reasons.push(`Line items + tax + shipping = ${expected.toFixed(2)}, total is ${x.total.toFixed(2)}`);
      }
    }
  }
  return reasons;
}

function validDate(d: string | null): string | null {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) ? d : null;
}

export async function ingest(input: IngestInput): Promise<IngestOutcome> {
  const db = adminClient();

  if (input.messageId) {
    const { data: existing } = await db
      .from("receipts")
      .select("id")
      .eq("user_id", input.userId)
      .eq("source_message_id", input.messageId)
      .maybeSingle();
    if (existing) return { outcome: "duplicate", receiptId: existing.id, detail: "Already captured" };
  }

  const [{ data: cats }, { data: profile }] = await Promise.all([
    db.from("categories").select("id, name").eq("user_id", input.userId),
    db.from("profiles").select("business_description").eq("user_id", input.userId).maybeSingle(),
  ]);
  const categories = (cats ?? []) as { id: string; name: string }[];
  const categoryId = (name: string | null) =>
    name ? categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null : null;

  // Store emails' plain-text parts are often stubs ("view in browser"), so prefer the HTML.
  const text = (input.html ? htmlToText(input.html) : "") || input.text?.trim() || "";
  const { data: x, truncated } = await extractReceipt({
    text,
    subject: input.subject,
    from: input.from,
    date: input.date,
    pdfs: input.pdfs,
    images: input.images,
    categories: categories.map((c) => c.name),
    businessDescription: profile?.business_description,
  });

  if (!x.is_receipt || NON_RECEIPT_TYPES.has(x.document_type)) {
    return { outcome: "skipped", detail: `Not a receipt (${x.document_type})` };
  }

  const key = merchantKey(x.merchant);
  if (key && x.order_number) {
    const { data: dupes } = await db
      .from("receipts")
      .select("id")
      .eq("user_id", input.userId)
      .eq("merchant_key", key)
      .eq("order_number", x.order_number)
      .eq("document_type", x.document_type)
      .limit(1);
    if (dupes?.length) {
      return { outcome: "duplicate", receiptId: dupes[0].id, detail: `Order ${x.order_number} already captured` };
    }
  }

  // Keep the originals in private storage.
  const receiptId = crypto.randomUUID();
  const files = [...(input.existingFiles ?? [])];
  const toUpload: RawFile[] = input.skipStore ? [] : [...(input.pdfs ?? []), ...(input.images ?? [])];
  if (!input.skipStore) {
    const raw = input.rawName ?? "email";
    if (input.html) toUpload.unshift({ name: `${raw}.html`, mime: "text/html", bytes: new TextEncoder().encode(input.html) });
    else if (input.text) toUpload.unshift({ name: `${raw}.txt`, mime: "text/plain", bytes: new TextEncoder().encode(input.text) });
  }
  for (const [i, f] of toUpload.entries()) {
    const path = `${input.userId}/${receiptId}/${i}-${safeFilename(f.name)}`;
    const { error } = await db.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mime, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    files.push({ path, mime: f.mime, name: f.name });
  }

  const reasons = reviewReasons(x, truncated);
  const purchaseDate = validDate(x.purchase_date);
  if (x.purchase_date && !purchaseDate && !reasons.includes("Missing date")) reasons.push("Unreadable date");

  const { error: insertError } = await db.from("receipts").insert({
    id: receiptId,
    user_id: input.userId,
    source: input.source,
    source_message_id: input.messageId ?? null,
    connection_id: input.connectionId ?? null,
    source_url: input.sourceUrl ?? null,
    status: reasons.length ? "needs_review" : "ready",
    review_reasons: reasons,
    document_type: x.document_type,
    merchant: x.merchant,
    order_number: x.order_number,
    purchase_date: purchaseDate,
    currency: (x.currency || "USD").toUpperCase().slice(0, 3),
    subtotal: x.subtotal,
    tax: x.tax,
    shipping: x.shipping,
    discount: x.discount,
    total: x.total,
    payment_method: x.payment_method,
    category_id: categoryId(x.suggested_category),
    notes: x.notes,
    confidence: Math.max(0, Math.min(1, x.confidence)),
    email_subject: input.subject ?? null,
    email_from: input.from ?? null,
    files,
    extracted: x,
  });

  if (insertError) {
    // Lost a race with a concurrent run: the unique indexes caught a duplicate.
    const uploaded = files.filter((f) => f.path.startsWith(`${input.userId}/${receiptId}/`)).map((f) => f.path);
    if (uploaded.length) await db.storage.from(BUCKET).remove(uploaded);
    if (insertError.code === "23505") return { outcome: "duplicate", detail: "Already captured" };
    throw new Error(`Insert failed: ${insertError.message}`);
  }

  if (x.line_items.length) {
    const { error } = await db.from("line_items").insert(
      x.line_items.map((li, position) => ({
        receipt_id: receiptId,
        user_id: input.userId,
        position,
        description: li.description,
        store_sku: li.store_sku,
        quantity: li.quantity ?? 1,
        unit_price: li.unit_price,
        total: lineTotal(li),
        category_id: categoryId(li.suggested_category),
        pack_size: li.pack_size && li.pack_size > 0 ? Math.round(li.pack_size) : 1,
        tax_line: li.tax_line ?? null,
        use_type: li.use_type ?? null,
        tax_confidence: li.tax_confidence != null ? Math.max(0, Math.min(1, li.tax_confidence)) : null,
      })),
    );
    if (error) throw new Error(`Line item insert failed: ${error.message}`);
  }

  return { outcome: "receipt", receiptId, status: reasons.length ? "needs_review" : "ready" };
}
