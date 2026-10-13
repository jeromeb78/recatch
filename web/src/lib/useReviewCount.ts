import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "./supabase";
import { accountId } from "./account";

/** Number of receipts flagged for review; refreshed on every navigation. */
export function useReviewCount(enabled = true): number {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    supabase
      .from("receipts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", accountId())
      .eq("status", "needs_review")
      .then(({ count }) => setCount(count ?? 0));
  }, [pathname, enabled]);
  return count;
}
