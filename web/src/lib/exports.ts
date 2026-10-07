// Accounting export presets. Column layouts follow QuickBooks Online's bank-upload CSV and Xero's
// bank-statement and bill import templates; check them against the import screen you use.
import { toCsv } from "./csv";

export interface ExportLine {
  purchase_date: string | null;
  merchant: string | null;
  order_number: string | null;
  receipt_id: string;
  description: string;
  quantity: number;
  woo_sku: string | null;
  landed_total: number | null;
  tax_line: string | null;
  use_type: string | null;
}

export interface ExportReceipt {
  id: string;
  purchase_date: string | null;
  merchant: string | null;
  order_number: string | null;
  total: number | null;
  document_type: string;
  payment_method: string | null;
}

export interface ExportSettings {
  accounts: Record<string, string>;
  dateFormat: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";
  excludePersonal: boolean;
  xeroTaxType: string;
}

export const DEFAULT_ACCOUNTS: Record<string, string> = {
  cogs: "Cost of Goods Sold",
  c8: "Advertising & Marketing",
  c9: "Car & Truck",
  c13: "Equipment",
  c15: "Insurance",
  c17: "Legal & Professional Fees",
  c18: "Office Expenses",
  c20b: "Rent & Lease",
  c21: "Repairs & Maintenance",
  c22: "Supplies",
  c23: "Taxes & Licenses",
  c24a: "Travel",
  c24b: "Meals",
  c25: "Utilities",
  c27a: "Other Business Expenses",
  personal: "Owner's Draw",
  none: "Uncategorized Expense",
};

export const DEFAULT_SETTINGS: ExportSettings = {
  accounts: DEFAULT_ACCOUNTS,
  dateFormat: "MM/DD/YYYY",
  excludePersonal: true,
  xeroTaxType: "Tax Exempt",
};

export const PRESETS = {
  qbo_bank: { label: "QuickBooks Online · bank upload (one row per receipt)", file: "quickbooks-bank" },
  qbo_items: { label: "QuickBooks · itemized expenses (one row per item, with account)", file: "quickbooks-expenses" },
  xero_bank: { label: "Xero · bank statement import (one row per receipt)", file: "xero-statement" },
  xero_bills: { label: "Xero · bills import (one row per item, with account code)", file: "xero-bills" },
} as const;
export type PresetKey = keyof typeof PRESETS;

function fmtDate(d: string | null, f: ExportSettings["dateFormat"]): string {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return f === "YYYY-MM-DD" ? `${y}-${m}-${day}` : f === "DD/MM/YYYY" ? `${day}/${m}/${y}` : `${m}/${day}/${y}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const account = (s: ExportSettings, code: string | null) =>
  s.accounts[code ?? "none"] || DEFAULT_ACCOUNTS[code ?? "none"] || DEFAULT_ACCOUNTS.none;

/** Amount per receipt: included (non-personal) line items, or the receipt total when it has none. */
function receiptAmounts(receipts: ExportReceipt[], lines: ExportLine[], s: ExportSettings) {
  const byReceipt = new Map<string, ExportLine[]>();
  for (const l of lines) byReceipt.set(l.receipt_id, [...(byReceipt.get(l.receipt_id) ?? []), l]);
  return receipts.flatMap((r) => {
    const ls = byReceipt.get(r.id);
    let amount: number;
    if (ls?.length) {
      const kept = ls.filter((l) => !(s.excludePersonal && (l.use_type === "personal" || l.tax_line === "personal")));
      if (!kept.length) return [];
      amount = kept.reduce((a, l) => a + Number(l.landed_total ?? 0), 0);
    } else {
      if (r.total == null) return [];
      amount = Number(r.total);
    }
    const sign = r.document_type === "refund" ? 1 : -1; // money out is negative on a bank statement
    return [{ r, amount: r2(sign * amount) }];
  });
}

export function buildExport(preset: PresetKey, receipts: ExportReceipt[], lines: ExportLine[], s: ExportSettings): string {
  const keptLines = lines.filter((l) => !(s.excludePersonal && (l.use_type === "personal" || l.tax_line === "personal")));
  const memo = (l: ExportLine) =>
    `${l.quantity !== 1 ? `${l.quantity} × ` : ""}${l.description}${l.woo_sku ? ` [${l.woo_sku}]` : ""}`;

  switch (preset) {
    case "qbo_bank":
      return toCsv(
        receiptAmounts(receipts, lines, s).map(({ r, amount }) => ({
          Date: fmtDate(r.purchase_date, s.dateFormat),
          Description: [r.merchant ?? "Unknown", r.order_number && `#${r.order_number}`].filter(Boolean).join(" "),
          Amount: amount.toFixed(2),
        })),
        ["Date", "Description", "Amount"],
      );
    case "qbo_items":
      return toCsv(
        keptLines.map((l) => ({
          Date: fmtDate(l.purchase_date, s.dateFormat),
          Payee: l.merchant ?? "",
          "Ref No": l.order_number ?? "",
          Account: account(s, l.tax_line),
          Memo: memo(l),
          Amount: r2(Number(l.landed_total ?? 0)).toFixed(2),
        })),
        ["Date", "Payee", "Ref No", "Account", "Memo", "Amount"],
      );
    case "xero_bank":
      return toCsv(
        receiptAmounts(receipts, lines, s).map(({ r, amount }) => ({
          Date: fmtDate(r.purchase_date, s.dateFormat),
          Amount: amount.toFixed(2),
          Payee: r.merchant ?? "",
          Description: r.payment_method ?? "",
          Reference: r.order_number ?? "",
        })),
        ["Date", "Amount", "Payee", "Description", "Reference"],
      );
    case "xero_bills":
      return toCsv(
        keptLines.map((l) => ({
          "*ContactName": l.merchant ?? "Unknown supplier",
          "*InvoiceNumber": l.order_number || `RC-${l.receipt_id.slice(0, 8)}`,
          "*InvoiceDate": fmtDate(l.purchase_date, s.dateFormat),
          "*DueDate": fmtDate(l.purchase_date, s.dateFormat),
          InventoryItemCode: "",
          "*Description": memo(l),
          "*Quantity": "1",
          "*UnitAmount": r2(Number(l.landed_total ?? 0)).toFixed(2),
          "*AccountCode": account(s, l.tax_line),
          "*TaxType": s.xeroTaxType,
        })),
        ["*ContactName", "*InvoiceNumber", "*InvoiceDate", "*DueDate", "InventoryItemCode", "*Description",
          "*Quantity", "*UnitAmount", "*AccountCode", "*TaxType"],
      );
  }
}
