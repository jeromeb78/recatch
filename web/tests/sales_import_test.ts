import { assertEquals } from "jsr:@std/assert@1";
import { detectPreset, importSales, money, parseCsv, parseDate, type ImportResult } from "../src/lib/salesImport.ts";
import { candidatesFrom, similarity, suggest } from "../src/lib/skuMatch.ts";

const ok = (r: ImportResult | { error: string }) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

Deno.test("csv parsing", () => {
  assertEquals(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n\n"multi\nline",2'), [["a", "b"], ["x, y", 'he said "hi"'], ["multi\nline", "2"]]);
  assertEquals(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

Deno.test("dates and money", () => {
  assertEquals(["2026-01-05 10:22:01 -0500", "1/5/26", "01/05/2026", "Jan-05-26", "Jan 5, 2026", "05-Jan-2026", "nope"].map(parseDate),
    ["2026-01-05", "2026-01-05", "2026-01-05", "2026-01-05", "2026-01-05", "2026-01-05", null]);
  assertEquals(["$1,234.50", "-$3.00", "($2.10)", "US $4", "", "--"].map((v) => money(v)), [1234.5, -3, -2.1, 4, 0, 0]);
});

Deno.test("eBay transaction report: orders, fees, refunds, preamble lines", () => {
  const csv = [
    "Transaction report",
    "Period,Jan 1 2026 - Jan 31 2026",
    "",
    "Transaction creation date,Type,Order number,Buyer username,Buyer name,Item title,Custom label,Quantity,Item subtotal,Shipping and handling,Seller collected tax,Final Value Fee - fixed,Final Value Fee - variable,Regulatory operating fee,Gross transaction amount,Net amount",
    'Jan-05-26,Order,11-1111-1111,buyer1,Pat Doe,"Hot Wheels \'67 Camaro",HW-67,2,20.00,5.00,1.50,0.30,2.66,0.08,26.50,23.46',
    "Jan-05-26,Order,11-1111-1111,buyer1,Pat Doe,Mystery box,,1,10.00,5.00,1.50,0.30,1.20,0.04,11.50,9.96",
    "Jan-20-26,Refund,11-1111-1111,buyer1,Pat Doe,Mystery box,,1,,,,,-1.20,,-11.50,-10.30",
    "Jan-31-26,Shipping label,,,,,,,,,,,,,-4.75,-4.75",
  ].join("\n");
  const rows = parseCsv(csv);
  assertEquals(detectPreset(rows), "ebay");
  const r = ok(importSales(csv, "ebay"));
  assertEquals(r.orders.length, 2);
  const o = r.orders.find((x) => x.external_id === "11-1111-1111")!;
  assertEquals([o.order_date, o.items_total, o.shipping_charged, o.tax_collected, o.refunded, o.status], ["2026-01-05", 30, 5, 1.5, 11.5, "paid"]);
  assertEquals(o.fees, 3.38); // 0.30+2.66+0.08 + 0.30+1.20+0.04 − 1.20 credited back
  assertEquals(o.lines.map((l) => [l.sku, l.quantity, l.total]), [["HW-67", 2, 20], [null, 1, 10]]);
  assertEquals(JSON.stringify(r).includes("Pat Doe") || JSON.stringify(r).includes("buyer1"), false);
  const label = r.orders.find((x) => x.external_id === "fees-2026-01")!;
  assertEquals([label.fees, label.lines.length, label.items_total], [4.75, 0, 0]);
});

Deno.test("Etsy order items: order shipping repeated on each row counts once", () => {
  const csv = "Sale Date,Item Name,Buyer,Quantity,Price,Discount Amount,Order Shipping,Order Sales Tax,Item Total,Transaction ID,Order ID,SKU\n" +
    "01/10/2026,Camaro,Pat,1,12.00,0,4.00,1.00,12.00,1,900,HW-67\n" +
    "01/10/2026,Mustang,Pat,2,8.00,1.00,4.00,1.00,15.00,2,900,HW-68\n";
  assertEquals(detectPreset(parseCsv(csv)), "etsy");
  const o = ok(importSales(csv, "etsy")).orders[0];
  assertEquals([o.items_total, o.shipping_charged, o.tax_collected, o.lines.length], [27, 4, 1, 2]);
});

Deno.test("Shopify orders: order fields on the first row only, refunds and statuses", () => {
  const csv = "Name,Email,Financial Status,Paid at,Subtotal,Shipping,Taxes,Total,Refunded Amount,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Lineitem discount,Created at\n" +
    "#1001,a@b.c,partially_refunded,2026-02-01 10:00:00 -0500,30,6,2,38,5,1,Camaro,10,HW-67,0,2026-02-01 09:00:00 -0500\n" +
    "#1001,,,,,,,,,2,Mustang,10,HW-68,0,2026-02-01 09:00:00 -0500\n" +
    "#1002,x@y.z,refunded,2026-02-03,10,0,0,10,10,1,Camaro,10,HW-67,0,2026-02-03\n" +
    "#1003,x@y.z,voided,,10,0,0,10,0,1,Camaro,10,HW-67,0,2026-02-04\n";
  assertEquals(detectPreset(parseCsv(csv)), "shopify");
  const r = ok(importSales(csv, "shopify"));
  const s = Object.fromEntries(r.orders.map((o) => [o.external_id, o]));
  assertEquals([s["#1001"].items_total, s["#1001"].shipping_charged, s["#1001"].refunded, s["#1001"].status], [30, 6, 5, "paid"]);
  assertEquals([s["#1002"].status, s["#1003"].status, s["#1003"].order_date], ["refunded", "cancelled", "2026-02-04"]);
  assertEquals(JSON.stringify(r).includes("@"), false);
});

Deno.test("generic mapping", () => {
  const csv = "When,What,Code,Qty,Amount,State\n2026-03-01,Camaro,HW-67,1,12,Completed\n2026-03-02,Mustang,,1,9,Refunded\nbad,Row,,1,1,\n";
  assertEquals("error" in importSales(csv, "generic", {}), true);
  const r = ok(importSales(csv, "generic", { date: "When", name: "What", sku: "Code", quantity: "Qty", total: "Amount", status: "State" }));
  assertEquals(r.orders.map((o) => [o.order_date, o.status, o.items_total]), [["2026-03-01", "paid", 12], ["2026-03-02", "refunded", 9]]);
  assertEquals([r.skipped, r.from, r.to], [1, "2026-03-01", "2026-03-02"]);
});

Deno.test("SKU suggestions", () => {
  const cands = candidatesFrom(
    [{ sku: "HW-67", name: "HW '67 Camaro (red)" }, { sku: "HW-68", name: "Hot Wheels 68 Mustang" }, { sku: "MB-12", name: "Matchbox Land Rover" }],
    [{ sku: "hw-67", name: "dup" }, { sku: "BOX-1", name: "Mystery box" }],
  );
  assertEquals(cands.length, 4);
  assertEquals(suggest("Hot Wheels '67 Camaro Red 1:64 Die-cast", cands)[0].sku, "HW-67");
  assertEquals(suggest("Matchbox Land Rover Defender 90", cands)[0].sku, "MB-12");
  assertEquals(suggest("Paper towels 6 pack", cands), []);
  assertEquals(suggest("Restock MB-12 x 4", cands)[0], { sku: "MB-12", name: "Matchbox Land Rover", score: 1 });
  assertEquals(similarity("Camaro 67", "Mustang 68") < 0.34, true);
});
