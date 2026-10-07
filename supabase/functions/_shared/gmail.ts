// Minimal Gmail REST client (no SDK).
import { base64ToBytes, env } from "./utils.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export const DEFAULT_SENDERS = [
  "walmart.com", "target.com", "amazon.com", "costco.com", "homedepot.com", "lowes.com",
  "bestbuy.com", "ebay.com", "etsy.com", "uline.com", "staples.com", "pirateship.com", "usps.com",
];

export function receiptSenders(): string[] {
  const raw = Deno.env.get("RECEIPT_SENDERS");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SENDERS;
  return [...new Set(list)];
}

export function redirectUri(): string {
  return `${env("SUPABASE_URL")}/functions/v1/gmail-oauth`;
}

export class GmailAuthError extends Error {}

export async function exchangeCode(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${body.error_description ?? body.error}`);
  return body as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body.error_description ?? body.error ?? res.statusText;
    if (body.error === "invalid_grant") throw new GmailAuthError(`Gmail access was revoked or expired: ${msg}`);
    throw new Error(`Token refresh failed: ${msg}`);
  }
  return body.access_token as string;
}

export async function userEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  return (await res.json()).email as string;
}

async function gmailGet(token: string, path: string) {
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new GmailAuthError("Gmail rejected the access token");
  if (!res.ok) throw new Error(`Gmail ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

/** Gmail search: mail from any known store domain (`{a b}` means OR) after `since`. */
export function buildQuery(since: Date): string {
  const from = receiptSenders().map((d) => `from:${d}`).join(" ");
  const after = Math.floor(since.getTime() / 1000);
  return `{${from}} after:${after} -in:chats -in:drafts`;
}

/** Yields message ids (newest first), one page at a time. */
export async function* listMessageIds(token: string, q: string, maxPages = 10) {
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ q, maxResults: "100", includeSpamTrash: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await gmailGet(token, `/messages?${params}`);
    yield ((body.messages ?? []) as { id: string }[]).map((m) => m.id);
    pageToken = body.nextPageToken;
    if (!pageToken) return;
  }
}

interface GmailPart {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface ParsedMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  html?: string;
  text?: string;
  pdfs: { name: string; mime: string; bytes: Uint8Array }[];
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function getMessage(token: string, id: string): Promise<ParsedMessage> {
  const msg = await gmailGet(token, `/messages/${id}?format=full`);
  const payload = msg.payload as GmailPart;
  const header = (n: string) =>
    payload.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";

  const out: ParsedMessage = {
    id,
    subject: header("Subject"),
    from: header("From"),
    date: header("Date") || new Date(Number(msg.internalDate)).toUTCString(),
    pdfs: [],
  };
  const decoder = new TextDecoder();

  const walk = async (part: GmailPart) => {
    const isPdf = part.mimeType === "application/pdf" || /\.pdf$/i.test(part.filename ?? "");
    if (isPdf && (part.body?.attachmentId || part.body?.data)) {
      if ((part.body.size ?? 0) <= MAX_PDF_BYTES) {
        const data = part.body.data ??
          (await gmailGet(token, `/messages/${id}/attachments/${part.body.attachmentId}`)).data;
        out.pdfs.push({ name: part.filename || "attachment.pdf", mime: "application/pdf", bytes: base64ToBytes(data) });
      }
    } else if (!part.filename && part.body?.data) {
      if (part.mimeType === "text/html" && !out.html) out.html = decoder.decode(base64ToBytes(part.body.data));
      if (part.mimeType === "text/plain" && !out.text) out.text = decoder.decode(base64ToBytes(part.body.data));
    }
    for (const p of part.parts ?? []) await walk(p);
  };
  await walk(payload);
  return out;
}
