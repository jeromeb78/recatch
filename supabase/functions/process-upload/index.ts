// Called by the web app after it uploads a photo/PDF to storage at {user_id}/uploads/...
// Body: { path: string }
import { ingest } from "../_shared/ingest.ts";
import { adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    const { path } = await req.json();
    if (typeof path !== "string" || !path.startsWith(`${user.id}/`) || path.includes("..")) {
      return json({ error: "Invalid path" }, 400);
    }

    const { data: blob, error } = await adminClient().storage.from("receipts").download(path);
    if (error || !blob) return json({ error: "File not found" }, 404);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = path.split("/").pop()!;
    const mime = (blob.type || "").split(";")[0] ||
      (/\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : "image/jpeg");

    const file = { name, mime, bytes };
    let pdfs, images;
    if (mime === "application/pdf") pdfs = [file];
    else if (IMAGE_TYPES.has(mime)) images = [file];
    else return json({ error: `Unsupported file type ${mime}. Upload a JPEG, PNG, WebP or PDF.` }, 415);

    const result = await ingest({
      userId: user.id,
      source: "upload",
      messageId: `upload:${path}`,
      pdfs,
      images,
      existingFiles: [{ path, mime, name }],
      // The original stays where it was uploaded; don't store a second copy.
      skipStore: true,
    });
    return json(result);
  } catch (e) {
    console.error("process-upload", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
