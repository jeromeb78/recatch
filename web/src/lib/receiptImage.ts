// Turns a receipt into files for an IRS document request: JPG pages of the receipt record (original + itemization),
// plus any original PDF unchanged. The IRS Document Upload Tool takes JPG, PNG or PDF, 15 MB per file, 40 per upload.
import { BUCKET, supabase } from "./supabase";
import { layoutRecord, PAGE, recordFileName, type Op, type RecordLine, type RecordOriginal, type RecordReceipt } from "./receiptRecord";
import type { LineItem, Receipt } from "./types";
import { date } from "./format";

export interface OutFile { name: string; blob: Blob }

const SOURCE_TEXT: Record<string, string> = {
  claude: "Text of the store's order page, as read by the Claude connector",
  extension: "Text of the store's order page, as captured by the browser extension",
  gmail: "Receipt email received in Gmail",
  forward: "Receipt email forwarded to Receipt Catcher",
  upload: "Photo or scan uploaded to Receipt Catcher",
};

/** Plain text of an HTML email/page, without scripts or styles. */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, head, noscript").forEach((n) => n.remove());
  doc.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, table, section").forEach((n) => n.append("\n"));
  doc.querySelectorAll("td, th").forEach((n) => n.append("\t"));
  return (doc.body.textContent ?? "").replace(/[  ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // decode() has finished reading; the element keeps its pixels.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Downloads a receipt's stored originals and describes them for the record. */
async function originals(r: Receipt): Promise<{ original: RecordOriginal; images: HTMLImageElement[]; pdfs: OutFile[] }> {
  const images: HTMLImageElement[] = [];
  const pdfs: OutFile[] = [];
  const texts: string[] = [];
  const names: string[] = [];
  for (const f of r.files ?? []) {
    const { data, error } = await supabase.storage.from(BUCKET).download(f.path);
    if (error || !data) continue;
    names.push(f.name);
    if (f.mime.startsWith("image/")) {
      try { images.push(await loadImage(data)); } catch { /* unreadable image: skip */ }
    } else if (f.mime === "application/pdf") {
      pdfs.push({ name: recordFileName(r, undefined, "pdf").replace(/\.pdf$/, `_original-${pdfs.length + 1}.pdf`), blob: data });
    } else if (f.mime === "text/html") {
      texts.push(htmlText(await data.text()));
    } else if (f.mime.startsWith("text/")) {
      texts.push((await data.text()).trim());
    }
  }
  const source = r.source_url ? `${SOURCE_TEXT[r.source] ?? "Captured document"} (${r.source_url})` : SOURCE_TEXT[r.source] ?? "Captured document";
  const caption = names.length
    ? `${source}. Captured ${date(r.created_at)}${names.length ? ` — ${names.join(", ")}` : ""}. Reproduced exactly as stored.`
    : `${source}. No original file was stored for this receipt.`;
  return {
    original: {
      caption,
      text: texts.join("\n\n— — —\n\n") || undefined,
      images: images.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })),
      note: pdfs.length ? `The original PDF is included next to this image as ${pdfs.map((p) => p.name).join(", ")}.` : undefined,
    },
    images,
    pdfs,
  };
}

function draw(ops: Op[], images: HTMLImageElement[]): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = PAGE.w;
  canvas.height = PAGE.h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE.w, PAGE.h);
  ctx.textBaseline = "top";
  for (const op of ops) {
    if (op.kind === "box") {
      ctx.fillStyle = op.fill;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.kind === "rule") {
      ctx.fillStyle = op.color ?? "#e3e6eb";
      ctx.fillRect(op.x, op.y, op.w, 2);
    } else if (op.kind === "image") {
      const img = images[op.index];
      if (img) ctx.drawImage(img, op.x, op.y, op.w, op.h);
      ctx.strokeStyle = "#d0d5dd";
      ctx.strokeRect(op.x, op.y, op.w, op.h);
    } else {
      ctx.font = op.font;
      ctx.fillStyle = op.color ?? "#111827";
      ctx.textAlign = op.align ?? "left";
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image"))), "image/jpeg", 0.9)
  );
}

let measureCtx: CanvasRenderingContext2D | null = null;
const measure = (text: string, font: string) => {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
};

/** JPG page(s) for one receipt, plus original PDFs. */
export async function irsFilesFor(r: Receipt, items?: LineItem[]): Promise<OutFile[]> {
  const lines = items ?? ((await supabase.from("line_items").select("*").eq("receipt_id", r.id).order("position")).data ?? []) as LineItem[];
  const { original, images, pdfs } = await originals(r);
  const pages = layoutRecord(r as unknown as RecordReceipt, lines as RecordLine[], original, measure);
  const out: OutFile[] = [];
  for (const [i, ops] of pages.entries()) {
    out.push({ name: recordFileName(r, pages.length > 1 ? i + 1 : undefined), blob: await draw(ops, images) });
  }
  return [...out, ...pdfs];
}

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
