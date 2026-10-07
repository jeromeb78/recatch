// Postmark inbound webhook: https://<ref>.supabase.co/functions/v1/inbound-email?secret=<INBOUND_SECRET>
// Users forward to <inbound address>+<their token>@…; Postmark puts the token in MailboxHash.
// To use another provider (SendGrid, Mailgun, Cloudflare Email Workers), adapt `parsePayload`.
import { ingest, RawFile } from "../_shared/ingest.ts";
import { adminClient, base64ToBytes, corsHeaders, env, json, timingSafeEqual } from "../_shared/utils.ts";

interface PostmarkAttachment {
  Name: string;
  Content: string;
  ContentType: string;
  ContentLength: number;
}

interface PostmarkInbound {
  MessageID: string;
  From: string;
  FromFull?: { Email: string; Name: string };
  To: string;
  OriginalRecipient?: string;
  MailboxHash?: string;
  Subject: string;
  Date: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Attachments?: PostmarkAttachment[];
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function tokenFrom(p: PostmarkInbound): string | null {
  if (p.MailboxHash) return p.MailboxHash.trim().toLowerCase();
  const addr = p.OriginalRecipient ?? p.To ?? "";
  const m = addr.match(/\+([a-z0-9]+)@/i);
  return m ? m[1].toLowerCase() : null;
}

function parsePayload(p: PostmarkInbound) {
  const pdfs: RawFile[] = [];
  const images: RawFile[] = [];
  const unsupported: string[] = [];
  for (const a of p.Attachments ?? []) {
    if (a.ContentLength > MAX_ATTACHMENT_BYTES) continue;
    const mime = a.ContentType.toLowerCase().split(";")[0];
    if (mime === "application/pdf" || /\.pdf$/i.test(a.Name)) {
      pdfs.push({ name: a.Name, mime: "application/pdf", bytes: base64ToBytes(a.Content) });
    } else if (IMAGE_TYPES.has(mime)) {
      // Skip tiny inline images (logos, tracking pixels).
      if (a.ContentLength > 20_000) images.push({ name: a.Name, mime, bytes: base64ToBytes(a.Content) });
    } else if (mime.startsWith("image/")) {
      unsupported.push(a.Name);
    }
  }
  return { pdfs, images, unsupported };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = new URL(req.url).searchParams.get("secret") ?? "";
  if (!timingSafeEqual(secret, env("INBOUND_SECRET"))) return json({ error: "Unauthorized" }, 401);

  // From here on always answer 200 so Postmark doesn't retry emails we've deliberately dropped.
  try {
    const payload = (await req.json()) as PostmarkInbound;
    const token = tokenFrom(payload);
    if (!token) return json({ ok: false, reason: "no token in recipient address" });

    const { data: profile } = await adminClient()
      .from("profiles").select("user_id").eq("inbound_token", token).maybeSingle();
    if (!profile) return json({ ok: false, reason: "unknown token" });

    const { pdfs, images, unsupported } = parsePayload(payload);
    if (!payload.HtmlBody && !payload.TextBody && !pdfs.length && !images.length) {
      return json({ ok: false, reason: unsupported.length ? "unsupported image format (HEIC?)" : "empty email" });
    }

    const result = await ingest({
      userId: profile.user_id,
      source: "forward",
      messageId: `postmark:${payload.MessageID}`,
      subject: payload.Subject,
      from: payload.From,
      date: payload.Date,
      html: payload.HtmlBody,
      text: payload.TextBody,
      pdfs,
      images,
    });
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("inbound-email", e);
    // 500 lets Postmark retry transient failures (e.g. Claude or storage hiccups).
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
