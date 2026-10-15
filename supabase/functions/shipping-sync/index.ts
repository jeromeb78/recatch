// Connects an Easyship account with an API access token and copies its shipments (label cost, courier, tracking and
// the store order each label was bought for) into shipments, to reconcile shipping cost against what customers paid.
// POST (user JWT, reports edit). Any body may include account: the owner id when working in an account the caller was
// invited to, and time_zone: the IANA zone used to date labels (defaults to America/New_York).
//   { action: "connect", token, name?, business? } → { account }
//   { action: "sync", shipping_account }          → { shipments, done }   call again while done is false
//   { action: "rekey", shipping_account, token }  → { ok }
// Removing an account is a plain delete from the app (its Vault token goes with it).
import { accountFor, adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";
import { checkToken, mapShipment, type EasyshipShipment } from "../_shared/easyship.ts";

const API = "https://public-api.easyship.com/2024-09";
const PAGES_PER_CALL = 8;
const LOOKBACK_MS = 86400_000;

class ShipError extends Error {}

async function easyshipGet(token: string, params: Record<string, string>) {
  const url = new URL(`${API}/shipments`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new ShipError("Couldn't reach Easyship. Try again in a minute.");
  }
  if (res.status === 401) throw new ShipError("Easyship didn't accept that token. It may have been deleted — create a new one under Connect → API Integration.");
  if (res.status === 403) throw new ShipError("The token can't read shipments. Give it the shipment read scope (public.shipment:read).");
  if (res.status === 429) throw new ShipError("Easyship asked us to slow down. Try again in a minute.");
  if (!res.ok) throw new ShipError(`Easyship answered with an error (${res.status})`);
  const body = await res.json() as { shipments?: EasyshipShipment[]; meta?: { pagination?: { next?: number | null } } };
  return { shipments: body.shipments ?? [], next: body.meta?.pagination?.next ?? null };
}

async function save(owner: string, accountId: string, shipments: EasyshipShipment[], tz: string) {
  const rows = shipments.filter((s) => s.easyship_shipment_id).map((s) => ({ ...mapShipment(s, tz), user_id: owner, account_id: accountId, updated_at: new Date().toISOString() }));
  if (!rows.length) return 0;
  const { error } = await adminClient().from("shipments").upsert(rows, { onConflict: "account_id,external_id" });
  if (error) throw error;
  return rows.length;
}

function validZone(z: unknown): string {
  if (typeof z !== "string" || z.length > 64) return "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return "America/New_York";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await userFromRequest(req);
  if (!caller) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();
  const body = await req.json().catch(() => ({}));
  const owner = await accountFor(caller, body?.account, "reports", "edit");
  if (!owner) return json({ error: "You don't have permission to manage shipping in this account" }, 403);
  const tz = validZone(body?.time_zone);

  try {
    if (body?.action === "connect") {
      const t = checkToken(body.token);
      if (!t.ok) return json({ error: t.error }, 400);
      const token = String(body.token).trim();
      await easyshipGet(token, { per_page: "1" }); // proves the token can read shipments
      const business = typeof body.business === "string" && body.business ? body.business : null;
      const name = (typeof body.name === "string" && body.name.trim()) || (t.sandbox ? "Easyship (sandbox)" : "Easyship");
      const { data: account, error } = await db.from("shipping_accounts")
        .insert({ user_id: owner, business_id: business, provider: "easyship", name: name.slice(0, 80) })
        .select("id, user_id, business_id, provider, name, status, last_error, last_synced_at, synced_through, backfill_cursor, created_at").single();
      if (error) throw error;
      const { error: vErr } = await db.rpc("shipping_secret_set", { p_account: account.id, p_secret: token });
      if (vErr) {
        await db.from("shipping_accounts").delete().eq("id", account.id);
        throw vErr;
      }
      return json({ account });
    }

    if (body?.action === "sync" || body?.action === "rekey") {
      const { data: acct } = await db.from("shipping_accounts")
        .select("id, user_id, synced_through, backfill_cursor").eq("id", String(body.shipping_account ?? "")).maybeSingle();
      if (!acct || acct.user_id !== owner) return json({ error: "Unknown shipping account" }, 404);

      if (body.action === "rekey") {
        const t = checkToken(body.token);
        if (!t.ok) return json({ error: t.error }, 400);
        await easyshipGet(String(body.token).trim(), { per_page: "1" });
        const { error } = await db.rpc("shipping_secret_set", { p_account: acct.id, p_secret: String(body.token).trim() });
        if (error) throw error;
        await db.from("shipping_accounts").update({ status: "active", last_error: null }).eq("id", acct.id);
        return json({ ok: true });
      }

      const { data: token, error: kErr } = await db.rpc("shipping_secret_get", { p_account: acct.id });
      if (kErr || typeof token !== "string") return json({ error: "Reconnect Easyship: its token is missing" }, 409);

      try {
        const started = new Date().toISOString();
        let saved = 0;
        if (acct.backfill_cursor !== "done") {
          // All history, a few pages per call. Labels bought meanwhile are picked up by the incremental pass, which starts
          // from when the history import began.
          let page = Number(acct.backfill_cursor) || 1;
          let finished = false;
          for (let i = 0; i < PAGES_PER_CALL; i++) {
            const r = await easyshipGet(token, { per_page: "100", page: String(page) });
            saved += await save(owner, acct.id, r.shipments, tz);
            if (!r.next || !r.shipments.length) { finished = true; break; }
            page = r.next;
          }
          await db.from("shipping_accounts").update({
            backfill_cursor: finished ? "done" : String(page), synced_through: acct.synced_through ?? started,
            status: "active", last_error: null, ...(finished ? { last_synced_at: new Date().toISOString() } : {}),
          }).eq("id", acct.id);
          return json({ shipments: saved, done: finished });
        }

        // Shipments created or changed (label bought, voided, delivered…) since the last sync.
        const since = new Date(new Date(acct.synced_through ?? 0).getTime() - LOOKBACK_MS).toISOString();
        let page = 1, complete = false;
        for (let i = 0; i < PAGES_PER_CALL; i++) {
          const r = await easyshipGet(token, { per_page: "100", page: String(page), updated_at_from: since });
          saved += await save(owner, acct.id, r.shipments, tz);
          if (!r.next || !r.shipments.length) { complete = true; break; }
          page = r.next;
        }
        await db.from("shipping_accounts").update({
          status: "active", last_error: null, ...(complete ? { synced_through: started, last_synced_at: new Date().toISOString() } : {}),
        }).eq("id", acct.id);
        return json({ shipments: saved, done: complete });
      } catch (e) {
        if (e instanceof ShipError) await db.from("shipping_accounts").update({ status: "error", last_error: e.message }).eq("id", acct.id);
        throw e;
      }
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof ShipError) return json({ error: e.message }, 502);
    console.error("shipping-sync", e);
    return json({ error: "Something went wrong syncing Easyship" }, 500);
  }
});
