// Connects a WooCommerce store and copies its orders and products into sales_orders / sales_lines / sales_products.
// POST (user JWT, reports edit). Any body may include account: the owner id when working in an account the caller
// was invited to.
//   { action: "connect", store_url, key, secret, name?, business? } → { channel }
//       Checks the keys against the store, then saves them encrypted in Vault. Read-only keys are enough.
//   { action: "sync", channel }                                   → { orders, done }
//       Fetches orders changed since the last sync, a few pages per call; call again while done is false.
//   { action: "rekey", channel, key, secret }                       → { ok }
// Disconnecting is a plain delete of the sales_channels row from the app (its Vault secret goes with it).
import { accountFor, adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";
import { isPublicHost, mapOrder, productCost, storeBase, validKeys, wooAuthHeader, type WooOrder } from "../_shared/woo.ts";

const PER_PAGE = 100;
const PAGES_PER_CALL = 8;

class StoreError extends Error {}

/** GET from the store, following at most 3 redirects and only to public https hosts. */
async function wooGet(base: string, path: string, key: string, secret: string, params: Record<string, string> = {}) {
  let url = new URL(`${base}/wp-json/wc/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: wooAuthHeader(key, secret), Accept: "application/json", "User-Agent": "ReceiptCatcher/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new StoreError("Couldn't reach the store. Check the address and that the site is online.");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location") ?? "", url);
      if (next.protocol !== "https:" || !isPublicHost(next.hostname)) throw new StoreError("The store redirected somewhere unexpected");
      url = next;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new StoreError("The store didn't accept those keys. Create a Read key under WooCommerce → Settings → Advanced → REST API.");
    }
    if (res.status === 404) throw new StoreError("No WooCommerce found at that address. Use your store's home page address.");
    if (!res.ok) throw new StoreError(`The store answered with an error (${res.status})`);
    const body = await res.json().catch(() => null);
    if (body === null) throw new StoreError("The store didn't send WooCommerce data. Check the address.");
    return { body, totalPages: Number(res.headers.get("x-wp-totalpages")) || 1 };
  }
  throw new StoreError("The store redirected too many times");
}

async function syncProducts(owner: string, channel: string, base: string, key: string, secret: string) {
  const db = adminClient();
  const rows: Record<string, unknown>[] = [];
  const variable: number[] = [];
  for (let page = 1; page <= 20; page++) {
    const { body, totalPages } = await wooGet(base, "products", key, secret, {
      per_page: String(PER_PAGE), page: String(page), status: "any", _fields: "id,sku,name,price,stock_quantity,type,cost_of_goods_sold,meta_data",
    });
    type P = { id: number; sku?: string; name?: string; price?: string; stock_quantity?: number | null; type?: string } & Parameters<typeof productCost>[0];
    for (const p of body as P[]) {
      if (p.type === "variable") variable.push(p.id);
      if (p.sku?.trim()) {
        rows.push({ user_id: owner, channel_id: channel, external_id: String(p.id), sku: p.sku.trim(), name: (p.name ?? "").slice(0, 300) || p.sku,
          price: p.price ? Number(p.price) || null : null, stock: p.stock_quantity ?? null, cost: productCost(p) });
      }
    }
    if (page >= totalPages) break;
  }
  // Variations carry their own SKUs (size, color…).
  for (const parent of variable.slice(0, 60)) {
    const { body } = await wooGet(base, `products/${parent}/variations`, key, secret, { per_page: String(PER_PAGE), _fields: "id,sku,name,price,stock_quantity,attributes,cost_of_goods_sold,meta_data" });
    type V = { id: number; sku?: string; price?: string; stock_quantity?: number | null; attributes?: { option?: string }[] } & Parameters<typeof productCost>[0];
    for (const v of body as V[]) {
      if (!v.sku?.trim()) continue;
      const parentName = (rows.find((r) => r.external_id === String(parent))?.name as string | undefined) ?? "";
      const opts = (v.attributes ?? []).map((a) => a.option).filter(Boolean).join(", ");
      rows.push({ user_id: owner, channel_id: channel, external_id: `${parent}:${v.id}`, sku: v.sku.trim(),
        name: [parentName, opts].filter(Boolean).join(" — ").slice(0, 300) || v.sku, price: v.price ? Number(v.price) || null : null, stock: v.stock_quantity ?? null,
        cost: productCost(v) });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("sales_products").upsert(rows.slice(i, i + 500), { onConflict: "channel_id,external_id" });
    if (error) throw error;
  }
  return rows.length;
}

async function saveOrders(owner: string, channel: { id: string; business_id: string | null }, orders: WooOrder[]) {
  const db = adminClient();
  const mapped = orders.map(mapOrder).filter((m): m is NonNullable<typeof m> => m !== null);
  if (!mapped.length) return 0;
  const now = new Date().toISOString();
  const { data: saved, error } = await db.from("sales_orders").upsert(
    mapped.map((m) => ({ ...m.order, user_id: owner, channel_id: channel.id, business_id: channel.business_id, updated_at: now })),
    { onConflict: "channel_id,external_id" },
  ).select("id, external_id");
  if (error) throw error;
  const idOf = new Map((saved ?? []).map((s) => [s.external_id as string, s.id as string]));
  const ids = [...idOf.values()];
  // Replace each order's lines (an edited order may have gained or lost items).
  const { error: delErr } = await db.from("sales_lines").delete().in("order_id", ids);
  if (delErr) throw delErr;
  const lines = mapped.flatMap((m) => m.lines.map((l) => ({ ...l, user_id: owner, order_id: idOf.get(m.order.external_id)! })));
  for (let i = 0; i < lines.length; i += 500) {
    const { error: e } = await db.from("sales_lines").insert(lines.slice(i, i + 500));
    if (e) throw e;
  }
  return mapped.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await userFromRequest(req);
  if (!caller) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();
  const body = await req.json().catch(() => ({}));
  const owner = await accountFor(caller, body?.account, "reports", "edit");
  if (!owner) return json({ error: "You don't have permission to manage sales in this account" }, 403);

  try {
    if (body?.action === "connect") {
      const base = storeBase(String(body.store_url ?? ""));
      if (typeof base !== "string") return json({ error: base.error }, 400);
      if (!validKeys(body.key, body.secret)) return json({ error: "Paste the Consumer key (ck_…) and Consumer secret (cs_…) from WooCommerce" }, 400);
      const key = body.key.trim(), secret = body.secret.trim();
      await wooGet(base, "orders", key, secret, { per_page: "1" }); // proves the keys can read orders
      const business = typeof body.business === "string" && body.business ? body.business : null;
      const name = (typeof body.name === "string" && body.name.trim()) || new URL(base).hostname.replace(/^www\./, "");
      const { data: channel, error } = await db.from("sales_channels")
        .insert({ user_id: owner, business_id: business, kind: "woocommerce", name: name.slice(0, 80), store_url: base })
        .select("id, user_id, business_id, kind, name, store_url, status, last_error, last_synced_at, synced_through, created_at").single();
      if (error) throw error;
      const { error: vErr } = await db.rpc("sales_secret_set", { p_channel: channel.id, p_secret: `${key}:${secret}` });
      if (vErr) {
        await db.from("sales_channels").delete().eq("id", channel.id);
        throw vErr;
      }
      return json({ channel });
    }

    if (body?.action === "sync" || body?.action === "rekey") {
      const { data: channel } = await db.from("sales_channels")
        .select("id, user_id, business_id, kind, store_url, synced_through, last_synced_at, backfill_cursor").eq("id", String(body.channel ?? "")).maybeSingle();
      if (!channel || channel.user_id !== owner) return json({ error: "Unknown store" }, 404);
      if (channel.kind !== "woocommerce" || !channel.store_url) return json({ error: "This channel is imported from files" }, 400);

      if (body.action === "rekey") {
        if (!validKeys(body.key, body.secret)) return json({ error: "Paste the Consumer key (ck_…) and Consumer secret (cs_…) from WooCommerce" }, 400);
        await wooGet(channel.store_url, "orders", body.key.trim(), body.secret.trim(), { per_page: "1" });
        const { error } = await db.rpc("sales_secret_set", { p_channel: channel.id, p_secret: `${body.key.trim()}:${body.secret.trim()}` });
        if (error) throw error;
        await db.from("sales_channels").update({ status: "active", last_error: null }).eq("id", channel.id);
        return json({ ok: true });
      }

      const { data: stored, error: sErr } = await db.rpc("sales_secret_get", { p_channel: channel.id });
      if (sErr || typeof stored !== "string") return json({ error: "Reconnect this store: its keys are missing" }, 409);
      const [key, secret] = stored.split(":");

      try {
        // Two passes, both paged by order id (stores don't reliably sort by modified date, so a "latest change" cursor can
        // skip orders): first every order the store has, then each later sync re-reads orders changed since the last one.
        // Progress is kept in backfill_cursor — "<page>" during history, "inc:<page>:<pass start>" mid-update, "done" between.
        const state = (channel.backfill_cursor as string | null) ?? "";
        const started = new Date().toISOString();
        const history = state !== "done" && !state.startsWith("inc:");
        const [, incPage, incStart] = state.match(/^inc:(\d+):(.+)$/) ?? [];
        let page = history ? Number(state) || 1 : Number(incPage) || 1;
        const passStart = history ? (state ? channel.synced_through as string : started) : incStart || started;
        const since = history ? null : new Date(new Date(channel.synced_through ?? 0).getTime() - 60_000).toISOString().replace(/\.\d+Z$/, "");
        let saved = 0, done = false;
        for (let i = 0; i < PAGES_PER_CALL; i++) {
          const params: Record<string, string> = { per_page: String(PER_PAGE), page: String(page), status: "any", orderby: "id", order: "asc", dates_are_gmt: "true" };
          if (since) params.modified_after = since;
          const { body: orders, totalPages } = await wooGet(channel.store_url, "orders", key, secret, params);
          saved += await saveOrders(owner, channel, orders as WooOrder[]);
          if (page >= totalPages || !(orders as unknown[]).length) { done = true; break; }
          page++;
        }
        const cursor = done ? "done" : history ? String(page) : `inc:${page}:${passStart}`;
        // Refresh the catalog once orders are caught up (and at most every few hours).
        let products: number | undefined;
        const stale = !channel.last_synced_at || Date.now() - new Date(channel.last_synced_at).getTime() > 3 * 3600_000;
        if (done && (stale || history)) products = await syncProducts(owner, channel.id, channel.store_url, key, secret);
        await db.from("sales_channels").update({
          backfill_cursor: cursor, status: "active", last_error: null,
          // The next update reads changes since this pass began, so nothing changed during it is missed.
          ...(done ? { synced_through: passStart, last_synced_at: new Date().toISOString() } : history && !state ? { synced_through: passStart } : {}),
        }).eq("id", channel.id);
        return json({ orders: saved, done, products });
      } catch (e) {
        if (e instanceof StoreError) {
          await db.from("sales_channels").update({ status: "error", last_error: e.message }).eq("id", channel.id);
        }
        throw e;
      }
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof StoreError) return json({ error: e.message }, 502);
    console.error("sales-sync", e);
    return json({ error: "Something went wrong syncing this store" }, 500);
  }
});
