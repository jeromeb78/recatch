// Receives a receipt photo or PDF straight from the phone — the iPhone Shortcut (Share sheet / Back Tap) or any
// app that can POST a file. Auth: `Authorization: Bearer rc_…` (a connection code from Settings → Phone).
// Body: the raw file (JPEG, PNG, WebP or PDF), or multipart/form-data with a "file" field.
// Replies in plain text so the Shortcut can show it as a notification.
import { ingest } from "../_shared/ingest.ts";
import { adminClient, corsHeaders, userFromApiToken } from "../_shared/utils.ts";

const MAX_IMAGE = 5 * 1024 * 1024; // what Claude accepts per image
const MAX_PDF = 25 * 1024 * 1024;

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });

/** File type from its first bytes (phones don't always send a useful Content-Type). */
export function sniff(b: Uint8Array): { mime: string; ext: string } | { heic: true } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (ascii(0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(ascii(8, 12))) return { heic: true };
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return text("Send the receipt with POST.", 405);

  const userId = await userFromApiToken(req);
  if (!userId) return text("Receipt Catcher: this connection code is wrong or was revoked. Make a new one in Settings → Phone.", 401);

  try {
    let bytes: Uint8Array<ArrayBuffer>;
    let name = "phone";
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const file = (await req.formData()).get("file");
      if (!file || typeof file === "string") return text("No file was sent.", 400);
      bytes = new Uint8Array(await file.arrayBuffer());
      name = file.name || name;
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }
    if (!bytes.length) return text("No file was sent. In the Shortcut, set Request Body to File.", 400);

    const kind = sniff(bytes);
    if (!kind) return text("That isn't a photo or PDF Receipt Catcher can read (JPEG, PNG, WebP or PDF).", 415);
    if ("heic" in kind) return text("iPhone HEIC photo: add a “Convert Image to JPEG” step before sending in the Shortcut.", 415);
    const isPdf = kind.mime === "application/pdf";
    if (bytes.length > (isPdf ? MAX_PDF : MAX_IMAGE)) {
      return text(isPdf ? "That PDF is over 25 MB." : "That photo is over 5 MB — add a “Resize Image” step (width 2000) in the Shortcut.", 413);
    }

    // Named by content: sending the same photo twice is recognised as already captured.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
    const path = `${userId}/uploads/${hash}-shortcut.${kind.ext}`;
    const db = adminClient();
    const { error: upErr } = await db.storage.from("receipts").upload(path, bytes, { contentType: kind.mime });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) throw upErr;

    const file = { name: `${name.replace(/[^\w.-]+/g, "_").slice(0, 60)}.${kind.ext}`, mime: kind.mime, bytes };
    const result = await ingest({
      userId,
      source: "upload",
      messageId: `upload:${path}`,
      pdfs: isPdf ? [file] : undefined,
      images: isPdf ? undefined : [file],
      existingFiles: [{ path, mime: kind.mime, name: file.name }],
      skipStore: true,
    });

    if (result.outcome === "skipped") return text(`Receipt Catcher couldn't find a receipt in that ${isPdf ? "PDF" : "photo"}. ${result.detail}.`);
    const { data: r } = await db.from("receipts").select("merchant, total, currency, status").eq("id", result.receiptId!).maybeSingle();
    const what = [r?.merchant, r?.total != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: r?.currency || "USD" }).format(Number(r.total)) : null]
      .filter(Boolean).join(" ");
    if (result.outcome === "duplicate") return text(`Already in Receipt Catcher${what ? `: ${what}` : ""}.`);
    return text(`Added to Receipt Catcher${what ? `: ${what}` : ""}${r?.status === "needs_review" ? " — needs a quick review" : ""}.`);
  } catch (e) {
    console.error("upload-receipt", e);
    return text(`Receipt Catcher hit an error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
