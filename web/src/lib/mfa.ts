import { supabase } from "./supabase";

export interface TotpFactor {
  id: string;
  friendly_name?: string;
  created_at: string;
}

/** Authenticator apps the signed-in person has finished setting up. */
export async function verifiedFactors(): Promise<TotpFactor[]> {
  const { data } = await supabase.auth.mfa.listFactors();
  return (data?.totp ?? []) as TotpFactor[];
}

/** True when this session still needs the 6-digit code (the account has two-step sign-in, the session doesn't). */
export async function needsSecondStep(): Promise<boolean> {
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return !!data && data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

/** Checks a 6-digit code from the person's authenticator app; upgrades the session to two-step (aal2). */
export async function verifyCode(code: string, factorId?: string): Promise<string | null> {
  const id = factorId ?? (await verifiedFactors())[0]?.id;
  if (!id) return "Two-step sign-in isn't set up.";
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: id, code: code.replace(/\s/g, "") });
  if (!error) return null;
  return /invalid|expired/i.test(error.message) ? "That code didn't match. Check the time on your phone and try the newest code." : error.message;
}
