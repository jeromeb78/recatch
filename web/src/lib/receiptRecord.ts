// Lays out a "receipt record" as US-letter pages for tax records (IRS document requests accept JPG, PNG or PDF).
// The original document is reproduced as captured — photo as-is, text verbatim — and the itemization
// recorded in Receipt Catcher is shown separately and labelled as such. Pure layout: drawing is in receiptImage.ts.
import { date, money } from "./format";

export const PAGE = { w: 1275, h: 1650, margin: 96 }; // 8.5 × 11 in at 150 dpi
const FOOTER_H = 70;
const BOTTOM = PAGE.h - PAGE.margin - FOOTER_H;
const CONTENT_W = PAGE.w - PAGE.margin * 2;

export const FONTS = {
  label: "600 18px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  title: "700 40px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  big: "700 40px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  h2: "700 26px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  body: "22px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  bold: "700 22px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  small: "18px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "18px ui-monospace, Menlo, Consolas, 'Liberation Mono', monospace",
};

export type Op =
  | { kind: "text"; x: number; y: number; text: string; font: string; color?: string; align?: "left" | "right" }
  | { kind: "rule"; x: number; y: number; w: number; color?: string }
  | { kind: "box"; x: number; y: number; w: number; h: number; fill: string }
  | { kind: "image"; x: number; y: number; w: number; h: number; index: number };

export type Measure = (text: string, font: string) => number;

export interface RecordLine {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total: number | null;
  use_type: string | null;
  business_pct: number | null;
}

export interface RecordReceipt {
  id: string;
  merchant: string | null;
  purchase_date: string | null;
  order_number: string | null;
  document_type: string;
  payment_method: string | null;
  currency: string;
  subtotal: number | null;
  discount: number | null;
  shipping: number | null;
  tax: number | null;
  total: number | null;
  source: string;
  source_url?: string | null;
  email_from?: string | null;
  email_subject?: string | null;
  notes?: string | null;
  created_at: string;
}

/** What the original looks like: verbatim text, images (natural size), or a note (e.g. "PDF attached"). */
export interface RecordOriginal {
  caption: string;
  text?: string;
  images?: { w: number; h: number }[];
  note?: string;
}

const SOURCE: Record<string, string> = {
  gmail: "Gmail", forward: "forwarded email", upload: "photo upload", extension: "browser extension", claude: "Claude connector",
};
const DOC: Record<string, string> = {
  receipt: "Receipt", order_confirmation: "Order confirmation", invoice: "Invoice", refund: "Refund",
};

export function wrap(text: string, font: string, maxW: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (measure(next, font) <= maxW) {
        line = next;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      // A single word wider than the line (URLs, long SKUs): break it by characters.
      while (measure(line, font) > maxW) {
        let n = line.length - 1;
        while (n > 1 && measure(line.slice(0, n), font) > maxW) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function useLabel(l: RecordLine): string {
  if (l.use_type === "mixed") return l.business_pct != null ? `${l.business_pct}% biz` : "Mixed";
  return l.use_type === "business" ? "Business" : l.use_type === "personal" ? "Personal" : "";
}

/** Splits a receipt record into pages of drawing operations. */
export function layoutRecord(
  r: RecordReceipt,
  lines: RecordLine[],
  original: RecordOriginal,
  measure: Measure,
  generatedAt = new Date(),
): Op[][] {
  const pages: Op[][] = [[]];
  let y = PAGE.margin;
  const M = PAGE.margin;
  const cur = () => pages[pages.length - 1];
  const push = (op: Op) => cur().push(op);
  const newPage = () => {
    pages.push([]);
    y = M;
  };
  const ensure = (h: number) => {
    if (y + h > BOTTOM) newPage();
  };
  const cur$ = r.currency || "USD";

  // Header
  push({ kind: "text", x: M, y, text: "RECEIPT RECORD", font: FONTS.label, color: "#5b6472" });
  y += 30;
  push({ kind: "text", x: M, y, text: r.merchant || "Unknown store", font: FONTS.title });
  push({ kind: "text", x: PAGE.w - M, y, text: money(r.total, cur$), font: FONTS.big, align: "right" });
  y += 62;
  push({ kind: "rule", x: M, y, w: CONTENT_W, color: "#111827" });
  y += 22;

  // Facts, two columns
  const facts: [string, string][] = [
    ["Date", date(r.purchase_date)],
    ["Order / receipt #", r.order_number || "—"],
    ["Document", DOC[r.document_type] ?? r.document_type],
    ["Paid with", r.payment_method || "—"],
    ["Captured from", r.source_url ? new URL(r.source_url).host : SOURCE[r.source] ?? r.source],
    ["Captured on", date(r.created_at)],
  ];
  if (r.email_from) facts.push(["Email from", r.email_from]);
  const colW = CONTENT_W / 2;
  for (let i = 0; i < facts.length; i += 2) {
    for (let j = 0; j < 2 && i + j < facts.length; j++) {
      const [k, v] = facts[i + j];
      const x = M + j * colW;
      push({ kind: "text", x, y, text: k.toUpperCase(), font: FONTS.label, color: "#5b6472" });
      const vLines = wrap(v, FONTS.body, colW - 24, measure).slice(0, 2);
      vLines.forEach((t, n) => push({ kind: "text", x, y: y + 24 + n * 28, text: t, font: FONTS.body }));
    }
    y += 70;
  }

  // Items
  const col = { qty: M + 640, unit: M + 800, amt: M + 960, use: PAGE.w - M };
  const descW = 600;
  const tableHeader = () => {
    push({ kind: "box", x: M, y: y - 6, w: CONTENT_W, h: 40, fill: "#f1f3f6" });
    push({ kind: "text", x: M + 10, y, text: "Item", font: FONTS.bold });
    push({ kind: "text", x: col.qty, y, text: "Qty", font: FONTS.bold, align: "right" });
    push({ kind: "text", x: col.unit, y, text: "Unit price", font: FONTS.bold, align: "right" });
    push({ kind: "text", x: col.amt, y, text: "Amount", font: FONTS.bold, align: "right" });
    push({ kind: "text", x: col.use, y, text: "Use", font: FONTS.bold, align: "right" });
    y += 48;
  };
  ensure(140);
  y += 8;
  push({ kind: "text", x: M, y, text: `Items (${lines.length})`, font: FONTS.h2 });
  y += 44;
  tableHeader();
  for (const l of lines) {
    const desc = wrap(l.description || "(item)", FONTS.body, descW, measure);
    const h = desc.length * 28 + 14;
    if (y + h > BOTTOM) {
      newPage();
      tableHeader();
    }
    desc.forEach((t, n) => push({ kind: "text", x: M + 10, y: y + n * 28, text: t, font: FONTS.body }));
    push({ kind: "text", x: col.qty, y, text: l.quantity != null ? String(Number(l.quantity)) : "", font: FONTS.body, align: "right" });
    push({ kind: "text", x: col.unit, y, text: l.unit_price != null ? money(l.unit_price, cur$) : "", font: FONTS.body, align: "right" });
    push({ kind: "text", x: col.amt, y, text: l.total != null ? money(l.total, cur$) : "", font: FONTS.body, align: "right" });
    push({ kind: "text", x: col.use, y, text: useLabel(l), font: FONTS.small, color: "#5b6472", align: "right" });
    y += h;
    push({ kind: "rule", x: M, y: y - 8, w: CONTENT_W, color: "#e3e6eb" });
  }
  if (!lines.length) {
    push({ kind: "text", x: M + 10, y, text: "No line items recorded.", font: FONTS.body, color: "#5b6472" });
    y += 36;
  }

  // Totals
  const totals: [string, number | null, boolean][] = [
    ["Subtotal", r.subtotal, false],
    ["Discount", r.discount != null && Number(r.discount) !== 0 ? -Math.abs(Number(r.discount)) : null, false],
    ["Shipping", r.shipping, false],
    ["Tax", r.tax, false],
    [r.document_type === "refund" ? "Refund total" : "Total", r.total, true],
  ];
  const shown = totals.filter(([, v, always]) => always || v != null);
  ensure(shown.length * 34 + 20);
  y += 8;
  for (const [k, v, bold] of shown) {
    push({ kind: "text", x: col.amt - 200, y, text: k, font: bold ? FONTS.bold : FONTS.body, align: "right" });
    push({ kind: "text", x: col.amt, y, text: money(v, cur$), font: bold ? FONTS.bold : FONTS.body, align: "right" });
    y += 34;
  }

  if (r.notes?.trim()) {
    const n = wrap(`Note: ${r.notes.trim()}`, FONTS.small, CONTENT_W, measure);
    ensure(n.length * 24 + 16);
    y += 10;
    n.forEach((t) => {
      push({ kind: "text", x: M, y, text: t, font: FONTS.small, color: "#5b6472" });
      y += 24;
    });
  }

  // Original document
  y += 20;
  ensure(140);
  push({ kind: "rule", x: M, y, w: CONTENT_W, color: "#111827" });
  y += 20;
  push({ kind: "text", x: M, y, text: "Original document", font: FONTS.h2 });
  y += 40;
  for (const t of wrap(original.caption, FONTS.small, CONTENT_W, measure)) {
    push({ kind: "text", x: M, y, text: t, font: FONTS.small, color: "#5b6472" });
    y += 26;
  }
  y += 12;
  if (original.note) {
    for (const t of wrap(original.note, FONTS.body, CONTENT_W, measure)) {
      ensure(30);
      push({ kind: "text", x: M, y, text: t, font: FONTS.body });
      y += 30;
    }
  }
  if (original.text) {
    const pad = 16;
    const textLines = wrap(original.text, FONTS.mono, CONTENT_W - pad * 2, measure);
    const LH = 24;
    let start = 0;
    while (start < textLines.length) {
      ensure(LH + pad * 2);
      const fit = Math.max(1, Math.floor((BOTTOM - y - pad * 2) / LH));
      const chunk = textLines.slice(start, start + fit);
      push({ kind: "box", x: M, y: y - 4, w: CONTENT_W, h: chunk.length * LH + pad * 2, fill: "#f7f8fa" });
      chunk.forEach((t, n) => push({ kind: "text", x: M + pad, y: y + pad + n * LH, text: t, font: FONTS.mono }));
      y += chunk.length * LH + pad * 2;
      start += chunk.length;
      if (start < textLines.length) newPage();
    }
  }
  (original.images ?? []).forEach((img, index) => {
    // Fit within the content width and one page; a tall photo gets its own page.
    const maxH = BOTTOM - M;
    const scale = Math.min(CONTENT_W / img.w, maxH / img.h, 1.5);
    const w = Math.round(img.w * scale), h = Math.round(img.h * scale);
    if (y + h > BOTTOM) newPage();
    push({ kind: "image", x: M + Math.round((CONTENT_W - w) / 2), y, w, h, index });
    y += h + 20;
  });

  // Footers (need the page count)
  const label = [r.merchant, date(r.purchase_date), r.order_number && `#${r.order_number}`].filter(Boolean).join(" · ");
  pages.forEach((ops, i) => {
    const fy = PAGE.h - PAGE.margin - FOOTER_H + 22;
    ops.push({ kind: "rule", x: M, y: fy - 12, w: CONTENT_W, color: "#e3e6eb" });
    ops.push({ kind: "text", x: M, y: fy, text: label, font: FONTS.small, color: "#5b6472" });
    ops.push({ kind: "text", x: PAGE.w - M, y: fy, text: `Page ${i + 1} of ${pages.length}`, font: FONTS.small, color: "#5b6472", align: "right" });
    ops.push({
      kind: "text", x: M, y: fy + 26, font: FONTS.small, color: "#8a93a1",
      text: `Items and totals as recorded in Receipt Catcher; original document shown unaltered. Ref ${r.id.slice(0, 8)}, ${generatedAt.toISOString().slice(0, 10)}`,
    });
  });
  return pages;
}

/** File name like 2026-08-14_Walmart_200014.jpg (safe for Windows/Mac and the IRS upload tool). */
export function recordFileName(r: Pick<RecordReceipt, "purchase_date" | "merchant" | "order_number" | "id">, page?: number, ext = "jpg"): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  const parts = [r.purchase_date ?? "undated", clean(r.merchant ?? "store") || "store", clean(r.order_number ?? "") || r.id.slice(0, 8)];
  return `${parts.join("_")}${page ? `_p${page}` : ""}.${ext}`;
}
