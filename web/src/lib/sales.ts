import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { accountId } from "./account";
import type { ImportOrder } from "./salesImport";

export interface Channel {
  id: string;
  business_id: string | null;
  kind: "woocommerce" | "csv";
  name: string;
  store_url: string | null;
  status: "active" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
}

const CHANNEL_COLUMNS = "id, business_id, kind, name, store_url, status, last_error, last_synced_at, created_at";

export function useChannels(enabled = true) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return setChannels([]);
    const { data } = await supabase.from("sales_channels").select(CHANNEL_COLUMNS).eq("user_id", accountId()).order("created_at");
    setChannels((data ?? []) as Channel[]);
  }, [enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { channels, reload };
}

async function fnError(error: unknown, fallback: string): Promise<string> {
  const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
  return (body as { error?: string } | null)?.error ?? fallback;
}

export async function callSales(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke("sales-sync", { body: { ...body, account: accountId() } });
  if (error) throw new Error(await fnError(error, "Couldn't reach the store"));
  return data as Record<string, unknown>;
}

/** Syncs a store until it's caught up. `onProgress` gets the running order count. */
export async function syncStore(channel: string, onProgress?: (orders: number) => void): Promise<number> {
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const r = await callSales({ action: "sync", channel });
    total += Number(r.orders) || 0;
    onProgress?.(total);
    if (r.done) break;
  }
  return total;
}

/** Stores synced over an hour ago get refreshed in the background; failures show on the channel. */
export async function refreshStale(channels: Channel[]): Promise<boolean> {
  const stale = channels.filter((c) => c.kind === "woocommerce" && c.status === "active"
    && (!c.last_synced_at || Date.now() - new Date(c.last_synced_at).getTime() > 3600_000));
  const results = await Promise.allSettled(stale.map((c) => syncStore(c.id)));
  return results.some((r) => r.status === "fulfilled" && r.value > 0);
}

/** Saves imported orders under a file channel: re-importing the same file updates rather than duplicates. */
export async function saveImport(channelId: string, businessId: string | null, orders: ImportOrder[], onProgress?: (done: number) => void) {
  const owner = accountId();
  const now = new Date().toISOString();
  for (let i = 0; i < orders.length; i += 200) {
    const chunk = orders.slice(i, i + 200);
    const { data: saved, error } = await supabase.from("sales_orders").upsert(
      chunk.map(({ lines: _lines, ...o }) => ({ ...o, user_id: owner, channel_id: channelId, business_id: businessId, updated_at: now })),
      { onConflict: "channel_id,external_id" },
    ).select("id, external_id");
    if (error) throw new Error(error.message);
    const idOf = new Map((saved ?? []).map((s) => [s.external_id as string, s.id as string]));
    if (chunk.some((o) => !idOf.has(o.external_id))) throw new Error("Some orders weren't saved. Try the import again.");
    const { error: delErr } = await supabase.from("sales_lines").delete().in("order_id", [...idOf.values()]);
    if (delErr) throw new Error(delErr.message);
    const lines = chunk.flatMap((o) => o.lines.map((l) => ({ ...l, user_id: owner, order_id: idOf.get(o.external_id)! })));
    if (lines.length) {
      const { error: lineErr } = await supabase.from("sales_lines").insert(lines);
      if (lineErr) throw new Error(lineErr.message);
    }
    onProgress?.(Math.min(orders.length, i + 200));
  }
}
