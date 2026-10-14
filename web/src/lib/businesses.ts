import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { accountId } from "./account";
import type { TaxProfile } from "./writeoffs";

import type { EntityType } from "./businessInfo";

export * from "./businessInfo";

export interface Business {
  id: string;
  name: string;
  entity_type: EntityType;
  ein: string | null;
  description: string | null;
  match_cards: string[];
  match_merchants: string[];
  tax_profile: TaxProfile;
  archived_at: string | null;
  created_at: string;
}

/** Businesses of the active account (archived ones last). */
export function useBusinesses() {
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const reload = useCallback(async () => {
    const { data } = await supabase.from("businesses").select("*").eq("user_id", accountId()).order("created_at");
    setBusinesses(((data ?? []) as Business[]).sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { businesses, active: (businesses ?? []).filter((b) => !b.archived_at), reload };
}
