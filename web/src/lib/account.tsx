import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabase";
import { allows, FULL, NONE, type Account, type Area, type Level, type Perms } from "./permissions";

export * from "./permissions";

// The account every query works on. Set by AccountProvider before any page renders, so plain
// functions (not just components) can scope their queries with accountId().
let current = "";
export const accountId = () => current;

const storageKey = (userId: string) => `recatch.account.${userId}`;
export const PENDING_INVITE_KEY = "recatch.invite";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

/** Remember which account to open next time (e.g. right after accepting an invite). */
export function rememberAccount(userId: string, ownerId: string) {
  writeStored(storageKey(userId), ownerId);
}

type Ctx = {
  account: Account;
  accounts: Account[];
  can: (area: Area, level?: Exclude<Level, "none">) => boolean;
  switchTo: (ownerId: string) => void;
  reload: () => Promise<void>;
  /** The owner of this shared account requires two-step sign-in and this session hasn't used it. */
  needsTwoStep: boolean;
};

const AccountContext = createContext<Ctx | null>(null);

export function useAccount(): Ctx {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount outside AccountProvider");
  return ctx;
}

export function AccountProvider({ userId, email, children }: { userId: string; email: string; children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [active, setActive] = useState<string>(() => readStored(storageKey(userId)) ?? userId);

  const reload = useCallback(async () => {
    const own: Account = { ownerId: userId, ownerEmail: email, own: true, perms: FULL };
    const { data } = await supabase.from("account_members").select("owner_id, owner_email, permissions").eq("member_id", userId)
      .order("owner_email");
    const shared = (data ?? []).map((m): Account => ({
      ownerId: m.owner_id,
      ownerEmail: m.owner_email ?? "another account",
      own: false,
      perms: { ...NONE, ...(m.permissions as Partial<Perms>) },
    }));
    setAccounts([own, ...shared]);
  }, [userId, email]);

  useEffect(() => {
    reload();
  }, [reload]);

  const [needsTwoStep, setNeedsTwoStep] = useState(false);
  const activeId = accounts ? (accounts.find((a) => a.ownerId === active) ?? accounts[0]).ownerId : null;
  useEffect(() => {
    if (!activeId || activeId === userId) return setNeedsTwoStep(false);
    Promise.all([
      supabase.rpc("team_requires_mfa", { p_owner: activeId }),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]).then(([req, aal]) => setNeedsTwoStep(!!req.data && aal.data?.currentLevel !== "aal2"));
  }, [activeId, userId]);

  if (!accounts) return <div className="center muted">Loading…</div>;

  // Fall back to their own account if access to the remembered one was removed.
  const account = accounts.find((a) => a.ownerId === active) ?? accounts[0];
  current = account.ownerId;

  const value: Ctx = {
    account,
    accounts,
    can: (area, level = "view") => allows(account.perms, area, level),
    switchTo: (ownerId) => {
      writeStored(storageKey(userId), ownerId);
      setActive(ownerId);
      // Start fresh so no page keeps showing the previous account's data.
      window.location.assign("/");
    },
    reload,
    needsTwoStep,
  };
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
