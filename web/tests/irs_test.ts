// deno test --sloppy-imports web/tests
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crc32, makeZip } from "../src/lib/zip.ts";
import { layoutRecord, PAGE, recordFileName, wrap, type RecordReceipt } from "../src/lib/receiptRecord.ts";

const measure = (t: string, font: string) => t.length * (Number(/(\d+)px/.exec(font)?.[1] ?? 20) * 0.55);

const r: RecordReceipt = {
  id: "0f0e0d0c-aaaa-bbbb-cccc-1234567890ab", merchant: "Walmart", purchase_date: "2026-08-14", order_number: "200014-77",
  document_type: "receipt", payment_method: "Visa ending 1234", currency: "USD", subtotal: 40, discount: null, shipping: 0,
  tax: 3.2, total: 43.2, source: "claude", created_at: "2026-10-11T01:00:00Z",
};

Deno.test("zip: CRC-32 and archive structure", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const zip = makeZip([{ name: "a/b.txt", data: new TextEncoder().encode("hello") }, { name: "c.txt", data: new Uint8Array([1, 2, 3]) }]);
  const v = new DataView(zip.buffer);
  assertEquals(v.getUint32(0, true), 0x04034b50); // first local header
  const end = zip.length - 22;
  assertEquals(v.getUint32(end, true), 0x06054b50);
  assertEquals(v.getUint16(end + 10, true), 2); // entries
  assertEquals(v.getUint32(end + 16, true) + v.getUint32(end + 12, true), end); // central dir offset + size
});

Deno.test("wrap keeps paragraphs and breaks long words", () => {
  const lines = wrap("Order details\n\nhttps://www.walmart.com/orders/1234567890123456789012345678901234567890", "20px mono", 300, measure);
  assertEquals(lines[0], "Order details");
  assertEquals(lines[1], "");
  assert(lines.length > 3);
  assert(lines.every((l) => measure(l, "20px mono") <= 300));
});

Deno.test("record: one page for a short receipt, verbatim original, footer on each page", () => {
  const pages = layoutRecord(r, [{ description: "Hot Wheels 5-Pack", quantity: 2, unit_price: 20, total: 40, use_type: "business", business_pct: null }],
    { caption: "Text of the store's order page", text: "Order #200014-77\nHot Wheels 5-Pack  $20.00 x2" }, measure, new Date("2026-10-14"));
  assertEquals(pages.length, 1);
  const texts = pages[0].filter((o) => o.kind === "text").map((o) => (o as { text: string }).text);
  assert(texts.includes("Walmart"));
  assert(texts.includes("Order #200014-77"), "original text is reproduced line for line");
  assert(texts.includes("Page 1 of 1"));
  assert(texts.some((t) => t.startsWith("Items and totals as recorded")));
  for (const o of pages[0]) if (o.kind === "text") assert(o.y < PAGE.h - 40, "nothing drawn off the page");
});

Deno.test("record: long originals and many items flow onto more pages", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i} with a fairly long name that wraps`, quantity: 1, unit_price: 1, total: 1, use_type: null, business_pct: null }));
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const pages = layoutRecord(r, lines, { caption: "c", text }, measure);
  assert(pages.length >= 4, `got ${pages.length} pages`);
  const all = pages.flat().filter((o) => o.kind === "text").map((o) => (o as { text: string }).text);
  for (let i = 0; i < 200; i++) assert(all.includes(`line ${i}`), `original line ${i} kept`);
  assert(all.includes(`Page ${pages.length} of ${pages.length}`));
  // The last 4 ops on each page are the footer; everything else must stay above it.
  for (const p of pages) for (const o of p.slice(0, -4)) if (o.kind === "text") {
    assert(o.y + 28 <= PAGE.h - PAGE.margin - 70, `text "${o.text}" overlaps the footer`);
  }
});

Deno.test("photo originals fit the page", () => {
  const pages = layoutRecord(r, [], { caption: "Photo", images: [{ w: 3024, h: 4032 }] }, measure);
  const img = pages.flat().find((o) => o.kind === "image") as { w: number; h: number; y: number };
  assert(img.w <= PAGE.w - PAGE.margin * 2 && img.y + img.h <= PAGE.h - PAGE.margin - 70);
});

Deno.test("file names are safe and sortable", () => {
  assertEquals(recordFileName(r), "2026-08-14_Walmart_200014-77.jpg");
  assertEquals(recordFileName({ ...r, merchant: "Sam's Club / Gas", order_number: null }, 2), "2026-08-14_Sam-s-Club-Gas_0f0e0d0c_p2.jpg");
});
