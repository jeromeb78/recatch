// Connects a Stripe account with a read-only restricted key and copies its charges (amount, refunds, fee, status and the
// store order each belongs to) into payments. Stripe is the source of truth for money; store orders say what was sold.
// POST (user JWT, reports edit). Any body may include account: the owner id when working in an account the caller was
// invited to, and time_zone: the IANA zone used to date charges (defaults to America/New_York).
//   { action: "connect", key, name?, business? } → { account }
//   { action: "sync", payment_account }         → { payments, done }   call again while done is false
//   { action: "rekey", payment_account, key }   → { ok }
// Removing an account is a plain delete from the app (its Vault key goes with it).
import { accountFor, adminClient, corsHeaders, json, userFromRequest } from "../_shared/utils.ts";
import { checkKey, mapCharge, type StripeCharge } from "../_shared/stripe.ts";

const PAGES_PER_CALL = 8;
const LOOKBACK = 86400; // re-read a day of overlap so nothing at the boundary is missed

class StripeError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function stripeGet(key: string, path: string, params: [string, string][] = []) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" }, signal: AbortSignal.timeout(25000) });
  } catch {
    throw new StripeError("Couldn't reach Stripe. Try again in a minute.");
  }
  if (res.status === 401) throw new StripeError("Stripe didn't accept that key. It may have been deleted or rolled — create a new restricted key.");
  if (res.status === 403) throw new StripeError("The key needs Read access to Charges and Refunds, and to Balance. Edit the key in Stripe and try again.", 403);
  if (res.status === 429) throw new StripeError("Stripe asked us to slow down. Try again in a minute.");
  if (!res.ok) throw new StripeError(`Stripe answered with an error (${res.status})`);
  return await res.json() as { data: unknown[]; has_more: boolean };
}

const EXPAND: [string, string][] = [["expand[]", "data.balance_transaction"]];

async function save(owner: string, accountId: string, charges: StripeCharge[], tz: string) {
  if (!charges.length) return 0;
  const now = new Date().toISOString();
  const rows = charges.map((c) => ({ ...mapCharge(c, tz), user_id: owner, account_id: accountId, updated_at: now }));
  const { error } = await adminClient().from("payments").upsert(rows, { onConflict: "account_id,external_id" });
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
  if (!owner) return json({ error: "You don't have permission to manage payments in this account" }, 403);
  const tz = validZone(body?.time_zone);

  try {
    if (body?.action === "connect") {
      const k = checkKey(body.key);
      if (!k.ok) return json({ error: k.error }, 400);
      const key = String(body.key).trim();
      await stripeGet(key, "charges", [["limit", "1"], ...EXPAND]); // proves the key can read charges and fees
      const business = typeof body.business === "string" && body.business ? body.business : null;
      const name = (typeof body.name === "string" && body.name.trim()) || (k.live ? "Stripe" : "Stripe (test mode)");
      const { data: account, error } = await db.from("payment_accounts")
        .insert({ user_id: owner, business_id: business, provider: "stripe", name: name.slice(0, 80), livemode: k.live })
        .select("id, user_id, business_id, provider, name, livemode, status, last_error, last_synced_at, synced_through, backfill_cursor, created_at").single();
      if (error) throw error;
      const { error: vErr } = await db.rpc("payment_secret_set", { p_account: account.id, p_secret: key });
      if (vErr) {
        await db.from("payment_accounts").delete().eq("id", account.id);
        throw vErr;
      }
      return json({ account });
    }

    if (body?.action === "sync" || body?.action === "rekey") {
      const { data: acct } = await db.from("payment_accounts")
        .select("id, user_id, synced_through, backfill_cursor").eq("id", String(body.payment_account ?? "")).maybeSingle();
      if (!acct || acct.user_id !== owner) return json({ error: "Unknown payment account" }, 404);

      if (body.action === "rekey") {
        const k = checkKey(body.key);
        if (!k.ok) return json({ error: k.error }, 400);
        await stripeGet(String(body.key).trim(), "charges", [["limit", "1"], ...EXPAND]);
        const { error } = await db.rpc("payment_secret_set", { p_account: acct.id, p_secret: String(body.key).trim() });
        if (error) throw error;
        await db.from("payment_accounts").update({ status: "active", last_error: null, livemode: k.live }).eq("id", acct.id);
        return json({ ok: true });
      }

      const { data: key, error: kErr } = await db.rpc("payment_secret_get", { p_account: acct.id });
      if (kErr || typeof key !== "string") return json({ error: "Reconnect Stripe: its key is missing" }, 409);

      try {
        const started = new Date().toISOString();
        let saved = 0;
        if (acct.backfill_cursor !== "done") {
          // History, newest first, a few pages per call. Changes made meanwhile are picked up by the incremental pass,
          // which starts from when the history import began.
          let cursor = acct.backfill_cursor as string | null;
          let finished = false;
          for (let page = 0; page < PAGES_PER_CALL; page++) {
            const params: [string, string][] = [["limit", "100"], ...EXPAND];
            if (cursor) params.push(["starting_after", cursor]);
            const r = await stripeGet(key, "charges", params);
            const charges = r.data as StripeCharge[];
            saved += await save(owner, acct.id, charges, tz);
            if (charges.length) cursor = charges[charges.length - 1].id;
            if (!r.has_more) { finished = true; break; }
          }
          await db.from("payment_accounts").update({
            backfill_cursor: finished ? "done" : cursor, synced_through: acct.synced_through ?? started,
            status: "active", last_error: null, ...(finished ? { last_synced_at: new Date().toISOString() } : {}),
          }).eq("id", acct.id);
          return json({ payments: saved, done: finished });
        }

        // New charges, and charges refunded or disputed, since the last sync.
        const since = String(Math.floor(new Date(acct.synced_through ?? 0).getTime() / 1000) - LOOKBACK);
        let complete = true;
        for (const kind of ["charges", "refunds", "disputes"] as const) {
          let after: string | null = null;
          for (let page = 0; ; page++) {
            if (page >= PAGES_PER_CALL) { complete = false; break; }
            const params: [string, string][] = [["limit", "100"], ["created[gte]", since]];
            if (kind === "charges") params.push(...EXPAND);
            else params.push(["expand[]", "data.charge"], ["expand[]", "data.charge.balance_transaction"]);
            if (after) params.push(["starting_after", after]);
            // Disputes need their own permission; without it, disputed charges are still updated when refunded.
            const r = await stripeGet(key, kind, params).catch((e) => {
              if (kind === "disputes" && e instanceof StripeError && e.status === 403) return { data: [], has_more: false };
              throw e;
            });
            const items = r.data as { id: string; charge?: StripeCharge | string }[];
            const charges = kind === "charges" ? (items as unknown as StripeCharge[])
              : items.map((x) => x.charge).filter((c): c is StripeCharge => !!c && typeof c === "object");
            saved += await save(owner, acct.id, charges, tz);
            if (items.length) after = items[items.length - 1].id;
            if (!r.has_more) break;
          }
        }
        await db.from("payment_accounts").update({
          status: "active", last_error: null, ...(complete ? { synced_through: started, last_synced_at: new Date().toISOString() } : {}),
        }).eq("id", acct.id);
        return json({ payments: saved, done: complete });
      } catch (e) {
        if (e instanceof StripeError) await db.from("payment_accounts").update({ status: "error", last_error: e.message }).eq("id", acct.id);
        throw e;
      }
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof StripeError) return json({ error: e.message }, 502);
    console.error("payments-sync", e);
    return json({ error: "Something went wrong syncing Stripe" }, 500);
  }
});
