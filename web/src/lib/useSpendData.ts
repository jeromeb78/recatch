import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { accountId } from "./account";
import { inRange, periodRange, type ALine, type AReceipt, type PeriodKey } from "./analytics";

const PAGE = 1000;

async function all<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (((data ?? []) as T[]).length < PAGE) return out;
  }
}

/** Receipts and items for a period and the one before it (for "vs previous"), for the analytics views. */
export function useSpendData(periodKey: PeriodKey, business: string) {
  const period = useMemo(() => periodRange(periodKey), [periodKey]);
  const [rows, setRows] = useState<{ receipts: AReceipt[]; lines: ALine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const from = period.prev?.from ?? period.from;
    const scope = <T,>(q: T): T => {
      const b = q as unknown as { eq(c: string, v: string): T; is(c: string, v: null): T; gte(c: string, v: string): T; lte(c: string, v: string): T };
      let out = business === "none" ? b.is("business_id", null) : business ? b.eq("business_id", business) : q;
      const o = out as unknown as typeof b;
      if (from) out = o.gte("purchase_date", from);
      if (period.to) out = (out as unknown as typeof b).lte("purchase_date", period.to);
      return out;
    };
    Promise.all([
      all<AReceipt>((a, z) => scope(supabase.from("receipts").select("id, merchant, purchase_date, total, document_type, status, business_id, category_id")
        .eq("user_id", accountId())).order("purchase_date").range(a, z)),
      all<ALine>((a, z) => scope(supabase.from("inventory_lines")
        .select("id, receipt_id, description, woo_sku, store_sku, quantity, units, landed_total, tax_line, use_type, business_pct, merchant, purchase_date")
        .eq("user_id", accountId())).order("purchase_date").range(a, z)),
    ]).then(([receipts, lines]) => !cancelled && setRows({ receipts, lines }))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => { cancelled = true; };
  }, [period, business]);

  const split = useMemo(() => {
    if (!rows) return null;
    const cur = {
      receipts: rows.receipts.filter((r) => !period.from || inRange(r.purchase_date, period.from, period.to)),
      lines: rows.lines.filter((l) => !period.from || inRange(l.purchase_date, period.from, period.to)),
    };
    const prev = period.prev ? {
      receipts: rows.receipts.filter((r) => inRange(r.purchase_date, period.prev!.from, period.prev!.to)),
      lines: rows.lines.filter((l) => inRange(l.purchase_date, period.prev!.from, period.prev!.to)),
    } : null;
    return { cur, prev };
  }, [rows, period]);

  return { period, data: split, error };
}
