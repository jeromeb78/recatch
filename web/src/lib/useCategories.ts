import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Category } from "./types";

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const reload = useCallback(async () => {
    const { data } = await supabase.from("categories").select("id, name, is_business, color").order("name");
    setCategories((data ?? []) as Category[]);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { categories, reload };
}
