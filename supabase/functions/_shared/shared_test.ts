// deno test supabase/functions/_shared
import { assert, assertEquals } from "jsr:@std/assert@1";
import { merchantKey, reviewReasons } from "./ingest.ts";
import type { Extraction } from "./extract.ts";
import { base64ToBytes, bytesToBase64, htmlToText, signPayload, verifyPayload } from "./utils.ts";

const item = {
  description: "", store_sku: null, quantity: 1, unit_price: null, total: null, suggested_category: null,
  pack_size: 1, tax_line: "c22", use_type: "business" as const, tax_confidence: 0.9,
};

const base: Extraction = {
  is_receipt: true, document_type: "receipt", merchant: "Target", merchant_domain: "target.com",
  order_number: "123", purchase_date: "2026-09-01", currency: "USD", subtotal: 10, tax: 0.8,
  shipping: null, discount: null, total: 10.8, payment_method: "Visa ending 1234", suggested_category: null,
  line_items: [
    { ...item, description: "A", quantity: 2, unit_price: 2.5, total: null },
    { ...item, description: "B", quantity: 1, unit_price: null, total: 5 },
  ],
  confidence: 0.95, notes: null,
};

Deno.test("clean receipt has no review reasons", () => {
  assertEquals(reviewReasons(base, false), []);
});

Deno.test("flags missing fields, low confidence, mismatched items", () => {
  const r = reviewReasons({ ...base, total: null, purchase_date: null, confidence: 0.4, subtotal: 12 }, true);
  assertEquals(r.length, 5);
  assert(r.some((x) => x.startsWith("Line items add up to 10.00")));
});

Deno.test("falls back to total check when subtotal missing", () => {
  assertEquals(reviewReasons({ ...base, subtotal: null }, false), []);
  assertEquals(reviewReasons({ ...base, subtotal: null, total: 20 }, false).length, 1);
});

Deno.test("merchantKey matches the SQL generated column", () => {
  assertEquals(merchantKey("Walmart.com"), "walmartcom");
  assertEquals(merchantKey("  "), null);
});

Deno.test("htmlToText keeps table structure and decodes entities", () => {
  const t = htmlToText("<style>x{}</style><table><tr><td>Item&nbsp;A</td><td>$1.00</td></tr></table><p>Tax &amp; fees</p>");
  assertEquals(t, "Item A\t$1.00\n\nTax & fees");
});

Deno.test("signed state round-trips and rejects tampering", async () => {
  const tok = await signPayload({ uid: "u1", exp: 1 }, "s3cret");
  assertEquals(await verifyPayload(tok, "s3cret"), { uid: "u1", exp: 1 });
  assertEquals(await verifyPayload(tok, "other"), null);
  assertEquals(await verifyPayload(tok.slice(0, -2) + "xx", "s3cret"), null);
});

Deno.test("base64 round-trip incl. base64url", () => {
  const bytes = new Uint8Array([251, 255, 0, 1, 2]);
  assertEquals(base64ToBytes(bytesToBase64(bytes)), bytes);
  assertEquals(base64ToBytes("-_8"), new Uint8Array([251, 255]));
});
