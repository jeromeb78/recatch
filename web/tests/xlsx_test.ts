import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isDateFormat, isSpreadsheet, readSpreadsheet, readXlsx, serialDate, toCsv } from "../src/lib/xlsx.ts";
import { detectReceiptPreset, importReceipts } from "../src/lib/receiptImport.ts";
import { parseCsv } from "../src/lib/salesImport.ts";
import { AMAZON_XLSX, MAC1904_XLSX, PREFIXED_XLSX } from "./xlsx_fixtures.ts";

// Fixtures are real workbooks saved by openpyxl (deflate-compressed zip, shared strings, styles).
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

Deno.test("xlsx: skips an empty first sheet, reads date cells as dates, numbers without float noise", async () => {
  const rows = await readXlsx(bytes(AMAZON_XLSX));
  assertEquals(rows, [
    ["Order Date", "Order ID", "Title", "Item Total", "Note"],
    ["2026-03-02", "112-1234567-1234567", 'Hot Wheels 5-Pack, "Track Stars"', "23.94"],
    ["2026-03-15", "112-7654321-7654321", "Poly Mailers 10x13", "21.97", "gift & co <b>"],
    [],
    ["", "0.3"],
  ]);
  // Round-trips through the CSV parser the importer uses, quotes and commas intact.
  assertEquals(parseCsv(toCsv(rows))[1][2], 'Hot Wheels 5-Pack, "Track Stars"');
});

Deno.test("xlsx: 1904 date system and a custom date format, then imported like a bank statement", async () => {
  const rows = await readXlsx(bytes(MAC1904_XLSX));
  assertEquals(rows[1], ["2025-12-31", "WALMART #123", "-42.18"]);
  assertEquals(rows[2], ["TRUE", "Refund", "5"]);
  const csv = toCsv(rows);
  assertEquals(detectReceiptPreset(parseCsv(csv)), "statement");
  const r = importReceipts(csv, "statement");
  if ("error" in r) throw new Error(r.error);
  assertEquals(r.receipts.map((x) => [x.merchant, x.purchase_date, x.total]), [["Walmart", "2025-12-31", 42.18]]);
});

Deno.test("xlsx: workbooks whose tags carry a namespace prefix (<x:row>, <x:c>) read the same", async () => {
  assertEquals(await readXlsx(bytes(PREFIXED_XLSX)), await readXlsx(bytes(MAC1904_XLSX)));
});

Deno.test("date formats and serials", () => {
  assertEquals([isDateFormat(14), isDateFormat(4), isDateFormat(164, "d-mmm-yy"), isDateFormat(165, '"$"#,##0.00'), isDateFormat(166, "[h]:mm")],
    [true, false, true, false, false]);
  assertEquals(serialDate(46083), "2026-03-02");
  assertEquals(serialDate(44560, true), "2025-12-31");
});

Deno.test("spreadsheet files: CSV passes through, old .xls explains how to re-save, junk zip is refused", async () => {
  assertEquals(isSpreadsheet({ name: "Orders.XLSX", type: "" }), true);
  assertEquals(isSpreadsheet({ name: "receipt.pdf", type: "application/pdf" }), false);
  assertEquals((await readSpreadsheet(new File(["a,b\n1,2"], "x.csv"))).text, "a,b\n1,2");
  assertEquals((await readSpreadsheet(new File([bytes(AMAZON_XLSX)], "orders.xlsx"))).text.split("\n")[1].startsWith("2026-03-02,"), true);
  await assertRejects(() => readSpreadsheet(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])], "old.xls")), Error, "Save As");
  await assertRejects(() => readXlsx(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])), Error, "valid Excel");
});
