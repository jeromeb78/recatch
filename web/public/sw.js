// Receipt Catcher service worker. Its only job is the Android share sheet: files shared to the installed app
// arrive as a POST to /share-target, are parked in Cache Storage, and the Snap page picks them up and uploads them.
// Nothing else is cached, so every deploy is live immediately and no receipt data is kept on the device.
const SHARE_CACHE = "shared-receipts";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.origin !== self.location.origin || url.pathname !== "/share-target") return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const files = form.getAll("receipts").filter((f) => f && typeof f !== "string");
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    await Promise.all(files.map((file, i) =>
      cache.put(`/shared/${i}`, new Response(file, {
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name || `shared-${i}`) },
      }))
    ));
    // Shared text (e.g. an e-receipt link) is passed along too; the page shows it.
    const note = [form.get("title"), form.get("text"), form.get("url")].filter((v) => typeof v === "string" && v).join(" ");
    const target = `/add?shared=${files.length}${note ? `&note=${encodeURIComponent(note.slice(0, 500))}` : ""}`;
    return Response.redirect(target, 303);
  })());
});
