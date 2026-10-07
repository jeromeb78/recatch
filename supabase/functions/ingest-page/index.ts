// Receives order / receipt pages from the Receipt Catcher browser extension.
// Auth: `Authorization: Bearer rc_…` (a connection code created in Settings).
// Body: { store, url, title?, text } or { ping: true }.
import { ingest } from "../_shared/ingest.ts";
import { corsHeaders, json, userFromApiToken } from "../_shared/utils.ts";

const STORES = new Set(["walmart", "target", "amazon", "other"]);
const MIN_TEXT = 150;
const MAX_TEXT = 400_000;

/** Stable per-order key so re-imports of the same page are skipped. */
function orderKey(url: URL): string {
  const id = url.searchParams.get("orderID") ?? url.searchParams.get("orderId");
  if (id) return id;
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || url.pathname;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userId = await userFromApiToken(req);
  if (!userId) return json({ error: "Invalid or revoked connection code" }, 401);

  try {
    const body = await req.json();
    if (body?.ping) return json({ ok: true });

    const store = String(body?.store ?? "other");
    const text = typeof body?.text === "string" ? body.text : "";
    let url: URL;
    try {
      url = new URL(String(body?.url));
    } catch {
      return json({ error: "Missing page url" }, 400);
    }
    if (!STORES.has(store)) return json({ error: "Unknown store" }, 400);
    if (url.protocol !== "https:") return json({ error: "Only https pages are accepted" }, 400);
    if (text.length < MIN_TEXT) return json({ outcome: "skipped", detail: "Page had no readable content yet" });

    const result = await ingest({
      userId,
      source: "extension",
      messageId: `ext:${url.hostname}:${orderKey(url)}`,
      subject: typeof body?.title === "string" ? body.title.slice(0, 300) : undefined,
      from: url.hostname,
      text: text.slice(0, MAX_TEXT),
      sourceUrl: url.toString(),
      rawName: "page",
    });
    return json(result);
  } catch (e) {
    console.error("ingest-page", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
