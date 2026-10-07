import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "./supabase";

/** Number of receipts flagged for review; refreshed on every navigation. */
export function useReviewCount(): number {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    supabase
      .from("receipts")
      .select("id", { count: "exact", head: true })
      .eq("status", "needs_review")
      .then(({ count }) => setCount(count ?? 0));
  }, [pathname]);
  return count;
}
