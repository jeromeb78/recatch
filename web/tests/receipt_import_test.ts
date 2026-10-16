import { assertEquals } from "jsr:@std/assert@1";
import { cleanMerchant, detectReceiptPreset, importReceipts, isDuplicate, type ImportReceipt, type ReceiptImportResult } from "../src/lib/receiptImport.ts";
import { parseCsv } from "../src/lib/salesImport.ts";

const ok = (r: ReceiptImportResult | { error: string }) => { if ("error" in r) throw new Error(r.error); return r; };

Deno.test("Amazon order history: one receipt per order, items with ASIN, cancelled skipped", () => {
  const csv = [
    '"Website","Order ID","Order Date","Purchase Order Number","Currency","Unit Price","Unit Price Tax","Shipping Charge","Total Discounts","Total Owed","Shipment Item Subtotal","Shipment Item Subtotal Tax","ASIN","Product Condition","Quantity","Payment Instrument Type","Order Status","Shipment Status","Ship Date","Shipping Option","Shipping Address","Billing Address","Carrier Name & Tracking Number","Product Name"',
    '"Amazon.com","111-1","2026-03-04T18:22:10Z","Not Applicable","USD","5.97","0.42","0","0","12.36","11.94","0.84","B0HW1","New","2","Visa - 4242","Closed","Shipped","2026-03-05","std","Pat Doe 1 Main St","Pat Doe","USPS","Hot Wheels Car Culture 5-Pack"',
    '"Amazon.com","111-1","2026-03-04T18:22:10Z","Not Applicable","USD","9.99","0.70","0","0","10.69","9.99","0.70","B0TAPE","New","1","Visa - 4242","Closed","Shipped","2026-03-05","std","Pat Doe","Pat Doe","USPS","Scotch Shipping Tape"',
    '"Amazon.com","222-2","2026-03-09","Not Applicable","USD","3","0","0","0","3","3","0","B0X","New","1","Visa","Cancelled","","","","","","","Cancelled thing"',
  ].join("\n");
  assertEquals(detectReceiptPreset(parseCsv(csv)), "amazon");
  const r = ok(importReceipts(csv, "amazon"));
  assertEquals(r.receipts.length, 1);
  const o = r.receipts[0];
  assertEquals([o.merchant, o.order_number, o.purchase_date, o.subtotal, o.tax, o.total, o.payment_method], ["Amazon", "111-1", "2026-03-04", 21.93, 1.12, 23.05, "Visa - 4242"]);
  assertEquals(o.items.map((i) => [i.description, i.quantity, i.unit_price, i.total, i.store_sku]),
    [["Hot Wheels Car Culture 5-Pack", 2, 5.97, 11.94, "B0HW1"], ["Scotch Shipping Tape", 1, 9.99, 9.99, "B0TAPE"]]);
  assertEquals(r.skipped, 1);
  assertEquals(JSON.stringify(r).includes("Main St"), false);
});

Deno.test("card statement: charges positive, payments skipped, refunds kept, same-day repeats stay separate", () => {
  const csv = "Transaction Date,Post Date,Description,Category,Type,Amount\n" +
    "10/01/2026,10/02/2026,SQ *BLUE BOTTLE #123 OAKLAND CA,Food,Sale,4.50\n" +
    "10/01/2026,10/02/2026,SQ *BLUE BOTTLE #123 OAKLAND CA,Food,Sale,4.50\n" +
    "10/03/2026,10/03/2026,AUTOMATIC PAYMENT - THANK YOU,,Payment,-500.00\n" +
    "10/04/2026,10/05/2026,TARGET 00012345,Shopping,Sale,61.20\n" +
    "10/06/2026,10/07/2026,TARGET 00012345,Shopping,Return,-12.00\n";
  assertEquals(detectReceiptPreset(parseCsv(csv)), "statement");
  const r = ok(importReceipts(csv, "statement"));
  assertEquals(r.receipts.map((x) => [x.merchant, x.purchase_date, x.total, x.document_type]),
    [["Blue Bottle", "2026-10-01", 4.5, "receipt"], ["Blue Bottle", "2026-10-01", 4.5, "receipt"], ["Target", "2026-10-04", 61.2, "receipt"], ["Target", "2026-10-06", 12, "refund"]]);
  assertEquals(r.receipts[0].key === r.receipts[1].key, false);
  assertEquals(r.skipped, 1);
});

Deno.test("bank export: spending negative, debit/credit columns", () => {
  const a = ok(importReceipts("Date,Description,Amount\n2026-09-01,COSTCO WHSE #0481,-212.43\n2026-09-02,PAYROLL DEPOSIT,2500\n", "statement"));
  assertEquals(a.receipts.map((x) => [x.merchant, x.total, x.document_type]), [["Costco Whse", 212.43, "receipt"]]);
  const b = ok(importReceipts("Posting Date,Description,Debit,Credit\n09/03/2026,UPS STORE 1234,18.20,\n09/04/2026,ONLINE TRANSFER,,100\n", "statement"));
  assertEquals(b.receipts.map((x) => [x.merchant, x.total]), [["Ups Store", 18.2]]);
});

Deno.test("generic: per-purchase and per-item files", () => {
  const per = ok(importReceipts("When,Shop,Paid\n2026-01-02,Hobby Lobby,19.99\nbad,x,1\n", "generic", { date: "When", store: "Shop", total: "Paid" }));
  assertEquals(per.receipts.map((x) => [x.merchant, x.total, x.items.length]), [["Hobby Lobby", 19.99, 0]]);
  const items = ok(importReceipts("Date,Store,Order,Item,Qty,Line\n2026-01-02,Walmart,W1,Tape,2,6\n2026-01-02,Walmart,W1,Boxes,1,10\n2026-01-03,Walmart,W2,Mailers,1,8\n",
    "generic", { date: "Date", store: "Store", order: "Order", item: "Item", quantity: "Qty", total: "Line" }));
  assertEquals(items.receipts.map((x) => [x.order_number, x.total, x.items.length]), [["W1", 16, 2], ["W2", 8, 1]]);
  assertEquals("error" in importReceipts("a,b\n1,2", "generic", {}), true);
});

Deno.test("merchant cleanup and duplicates", () => {
  assertEquals(["PAYPAL *EBAY INC", "TST* TACOS EL GORDO - LAS VEGAS NV", "WALMART.COM 8009256278", "Amazon.com*AB12CD"].map(cleanMerchant),
    ["Ebay Inc", "Tacos El Gordo - Las Vegas", "Walmart.com", "Amazon.com"]);
  const r: ImportReceipt = { key: "k", merchant: "Target", order_number: null, purchase_date: "2026-10-04", document_type: "receipt", subtotal: null, tax: null, shipping: null, total: 61.2, payment_method: null, items: [] };
  assertEquals(isDuplicate(r, [{ merchant: "Target", purchase_date: "2026-10-02", total: "61.20", order_number: null }]), true);
  assertEquals(isDuplicate(r, [{ merchant: "Target", purchase_date: "2026-09-20", total: 61.2, order_number: null }]), false);
  assertEquals(isDuplicate({ ...r, order_number: "111-1", merchant: "Amazon" }, [{ merchant: "Amazon.com", purchase_date: "2026-01-01", total: 1, order_number: "111-1" }]), true);
});
