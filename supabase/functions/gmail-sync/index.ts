// Pulls new receipt emails from connected Gmail accounts.
//   pg_cron:  POST with header x-cron-secret → every active connection
//   Web app:  POST with user JWT, body { backfill_days?: number } → the caller's connections
import { buildQuery, getMessage, GmailAuthError, listMessageIds, refreshAccessToken } from "../_shared/gmail.ts";
import { ingest } from "../_shared/ingest.ts";
import { adminClient, corsHeaders, env, json, timingSafeEqual, userFromRequest } from "../_shared/utils.ts";

const MAX_PER_RUN = Number(Deno.env.get("SYNC_MAX_PER_RUN") ?? 20);
const CONCURRENCY = 4;
const TIME_BUDGET_MS = 120_000; // stay under the edge function wall-clock limit
const ERROR_RETRY_MS = 24 * 3600_000;

interface Connection {
  id: string;
  user_id: string;
  email: string;
  refresh_token: string;
  sync_from: string;
}

interface ConnectionResult {
  email: string;
  receipts: number;
  duplicates: number;
  skipped: number;
  errors: number;
  remaining: boolean;
  error?: string;
}

/** Collects up to `limit` message ids not yet processed (errors are retried after a day). */
async function unseenIds(token: string, conn: Connection, limit: number) {
  const db = adminClient();
  const result: string[] = [];
  let exhausted = true;
  for await (const page of listMessageIds(token, buildQuery(new Date(conn.sync_from)))) {
    if (!page.length) continue;
    const { data } = await db
      .from("processed_messages")
      .select("message_id, outcome, processed_at")
      .eq("user_id", conn.user_id)
      .in("message_id", page);
    const cutoff = Date.now() - ERROR_RETRY_MS;
    const seen = new Set(
      (data ?? [])
        .filter((r) => r.outcome !== "error" || Date.parse(r.processed_at) > cutoff)
        .map((r) => r.message_id),
    );
    for (const id of page) {
      if (seen.has(id)) continue;
      if (result.length >= limit) {
        exhausted = false;
        break;
      }
      result.push(id);
    }
    if (!exhausted) break;
  }
  return { ids: result, remaining: !exhausted };
}

async function syncConnection(conn: Connection, deadline: number): Promise<ConnectionResult> {
  const db = adminClient();
  const res: ConnectionResult = { email: conn.email, receipts: 0, duplicates: 0, skipped: 0, errors: 0, remaining: false };

  let token: string;
  try {
    token = await refreshAccessToken(conn.refresh_token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("email_connections")
      .update({ status: e instanceof GmailAuthError ? "error" : "active", last_error: msg })
      .eq("id", conn.id);
    return { ...res, error: msg };
  }

  const { ids, remaining } = await unseenIds(token, conn, MAX_PER_RUN);
  res.remaining = remaining;

  const queue = [...ids];
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const id = queue.shift()!;
      let outcome: "receipt" | "duplicate" | "skipped" | "error" = "error";
      let receiptId: string | null = null;
      let detail: string | null = null;
      try {
        const msg = await getMessage(token, id);
        const r = await ingest({
          userId: conn.user_id,
          source: "gmail",
          messageId: id,
          connectionId: conn.id,
          subject: msg.subject,
          from: msg.from,
          date: msg.date,
          html: msg.html,
          text: msg.text,
          pdfs: msg.pdfs,
        });
        outcome = r.outcome;
        receiptId = "receiptId" in r ? r.receiptId ?? null : null;
        detail = "detail" in r ? r.detail : null;
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
        console.error(`gmail-sync ${conn.email} ${id}`, detail);
      }
      res[outcome === "receipt" ? "receipts" : outcome === "duplicate" ? "duplicates" : outcome === "skipped" ? "skipped" : "errors"]++;
      await db.from("processed_messages").upsert({
        user_id: conn.user_id,
        connection_id: conn.id,
        message_id: id,
        outcome,
        receipt_id: receiptId,
        detail,
        processed_at: new Date().toISOString(),
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (queue.length) res.remaining = true;

  await db.from("email_connections")
    .update({ last_synced_at: new Date().toISOString(), status: "active", last_error: null })
    .eq("id", conn.id);
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const deadline = Date.now() + TIME_BUDGET_MS;
  const db = adminClient();

  try {
    const cronSecret = req.headers.get("x-cron-secret");
    let query = db.from("email_connections")
      .select("id, user_id, email, refresh_token, sync_from")
      .eq("provider", "gmail")
      .neq("status", "revoked");

    if (cronSecret) {
      if (!timingSafeEqual(cronSecret, env("CRON_SECRET"))) return json({ error: "Unauthorized" }, 401);
      query = query.eq("status", "active");
    } else {
      const user = await userFromRequest(req);
      if (!user) return json({ error: "Unauthorized" }, 401);
      query = query.eq("user_id", user.id);

      const body = await req.json().catch(() => ({}));
      const days = Number(body?.backfill_days);
      if (days > 0) {
        const from = new Date(Date.now() - Math.min(days, 730) * 86400_000).toISOString();
        // Only ever widen the window.
        await db.from("email_connections").update({ sync_from: from }).eq("user_id", user.id).gt("sync_from", from);
      }
    }

    const { data: conns, error } = await query.order("last_synced_at", { ascending: true, nullsFirst: true });
    if (error) throw error;

    const results: ConnectionResult[] = [];
    for (const conn of (conns ?? []) as Connection[]) {
      if (Date.now() > deadline) break;
      results.push(await syncConnection(conn, deadline));
    }
    return json({ connections: results });
  } catch (e) {
    console.error("gmail-sync", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
