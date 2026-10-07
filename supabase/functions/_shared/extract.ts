import Anthropic from "npm:@anthropic-ai/sdk";
import { bytesToBase64, env } from "./utils.ts";

export type DocumentType =
  | "receipt"
  | "order_confirmation"
  | "invoice"
  | "refund"
  | "shipping_notice"
  | "other";

export interface ExtractedLineItem {
  description: string;
  store_sku: string | null;
  quantity: number | null;
  unit_price: number | null;
  total: number | null;
  suggested_category: string | null;
}

export interface Extraction {
  is_receipt: boolean;
  document_type: DocumentType;
  merchant: string | null;
  merchant_domain: string | null;
  order_number: string | null;
  purchase_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  shipping: number | null;
  discount: number | null;
  total: number | null;
  payment_method: string | null;
  suggested_category: string | null;
  line_items: ExtractedLineItem[];
  confidence: number;
  notes: string | null;
}

export interface ExtractInput {
  /** Plain text of the email or note (already converted from HTML). */
  text?: string;
  subject?: string;
  from?: string;
  date?: string;
  pdfs?: { name: string; bytes: Uint8Array }[];
  images?: { name: string; mime: string; bytes: Uint8Array }[];
  categories: string[];
}

export const MAX_TEXT_CHARS = 150_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const nullable = (type: string) => ({ type: [type, "null"] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_receipt", "document_type", "merchant", "merchant_domain", "order_number", "purchase_date",
    "currency", "subtotal", "tax", "shipping", "discount", "total", "payment_method",
    "suggested_category", "line_items", "confidence", "notes",
  ],
  properties: {
    is_receipt: {
      type: "boolean",
      description: "True only if this documents a completed purchase, order or refund with prices.",
    },
    document_type: {
      type: "string",
      enum: ["receipt", "order_confirmation", "invoice", "refund", "shipping_notice", "other"],
    },
    merchant: { ...nullable("string"), description: "Store name as customers know it, e.g. 'Walmart', 'Target', 'Amazon'." },
    merchant_domain: { ...nullable("string"), description: "e.g. walmart.com" },
    order_number: { ...nullable("string"), description: "Order / transaction / receipt number exactly as printed." },
    purchase_date: { ...nullable("string"), description: "Date of purchase or order, YYYY-MM-DD." },
    currency: { ...nullable("string"), description: "ISO 4217 code, e.g. USD." },
    subtotal: nullable("number"),
    tax: nullable("number"),
    shipping: nullable("number"),
    discount: { ...nullable("number"), description: "Total savings/coupons as a positive number." },
    total: { ...nullable("number"), description: "Amount charged. For refunds, the amount refunded (positive)." },
    payment_method: {
      ...nullable("string"),
      description: "Card brand and last 4 only, e.g. 'Visa ending 1234'. Never a full card number.",
    },
    suggested_category: { ...nullable("string"), description: "One of the user's category names, or null." },
    line_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "store_sku", "quantity", "unit_price", "total", "suggested_category"],
        properties: {
          description: { type: "string" },
          store_sku: { ...nullable("string"), description: "Store item number / UPC / ASIN / DPCI if shown." },
          quantity: nullable("number"),
          unit_price: nullable("number"),
          total: { ...nullable("number"), description: "Line total after quantity, before order-level tax." },
          suggested_category: nullable("string"),
        },
      },
    },
    confidence: { type: "number", description: "0 to 1: how sure you are the numbers are read correctly." },
    notes: { ...nullable("string"), description: "Anything a human should double-check." },
  },
} as const;

const SYSTEM = `You extract structured purchase data from receipts, order confirmations and invoices for a personal/small-business expense ledger.

Rules:
- Input may be a forwarded email, an HTML email converted to text, a PDF, or a photo of a paper receipt. For forwarded emails, the merchant is the original sender, not the person who forwarded it.
- Marketing emails, shipping/delivery updates without prices, account notices and surveys are not receipts: set is_receipt=false and document_type to "shipping_notice" or "other", and leave fields null with an empty line_items list.
- Money values are plain numbers without currency symbols. Discounts are positive numbers.
- Copy order numbers exactly. Use YYYY-MM-DD for dates; if the year is missing, infer it from the email date.
- One line item per distinct product line. Include quantity and unit price when shown. Do not include tax, shipping, or subtotal rows as line items.
- Never output full card numbers, only the brand and last four digits.
- suggested_category must be exactly one of the user's category names provided, or null if none fits.
- Lower confidence when the image is blurry, text is cut off, or totals are ambiguous, and say why in notes.`;

let client: Anthropic | null = null;

export async function extractReceipt(input: ExtractInput): Promise<{ data: Extraction; truncated: boolean }> {
  client ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const pdf of input.pdfs ?? []) {
    content.push({
      type: "document",
      title: pdf.name,
      source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(pdf.bytes) },
    });
  }
  for (const img of input.images ?? []) {
    if (!IMAGE_TYPES.has(img.mime)) {
      throw new Error(`Unsupported image type ${img.mime}. Use JPEG, PNG, WebP or GIF (iPhone: Settings › Camera › Formats › Most Compatible).`);
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mime as "image/jpeg", data: bytesToBase64(img.bytes) },
    });
  }

  let text = input.text ?? "";
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS);

  const header = [
    input.subject && `Subject: ${input.subject}`,
    input.from && `From: ${input.from}`,
    input.date && `Date: ${input.date}`,
  ].filter(Boolean).join("\n");

  content.push({
    type: "text",
    text: [
      `User's categories: ${input.categories.length ? input.categories.join(" | ") : "(none)"}`,
      header && `\n--- Email headers ---\n${header}`,
      text && `\n--- Body ---\n${text}`,
      "\nExtract the purchase data.",
    ].filter(Boolean).join("\n"),
  });

  const response = await client.beta.messages.create({
    model: Deno.env.get("CLAUDE_MODEL") || "claude-opus-5-5",
    max_tokens: 16000,
    system: SYSTEM,
    betas: ["server-side-fallback-2026-07-01"],
    // deno-lint-ignore no-explicit-any
    fallbacks: "default" as any,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") throw new Error("Extraction was declined by the model.");
  if (response.stop_reason === "max_tokens") throw new Error("Extraction output was cut off (max_tokens).");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Extraction returned no output.");
  const data = JSON.parse(textBlock.text) as Extraction;
  return { data, truncated };
}
