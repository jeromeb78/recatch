import { supabase } from "./supabase";

/**
 * Finishes "Connect Gmail" after Google's consent screen. The gmail-oauth function sends the browser back here with
 * ?gmail=finish&code=…&state=…; the connection is only saved from the signed-in session of the person who started it,
 * so a consent link someone else started can't attach your Gmail to their account.
 */
export async function finishGmail(params: URLSearchParams): Promise<{ email: string } | { error: string }> {
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return { error: "The link back from Google was incomplete. Try connecting again." };
  const { data, error } = await supabase.functions.invoke("gmail-oauth", { method: "POST", body: { action: "finish", code, state } });
  if (error) {
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    return { error: body?.error ?? "Couldn’t finish connecting Gmail. Try again." };
  }
  return { email: String(data?.email ?? "Gmail") };
}

/** The query without the one-time Google code and state, so they don't stay in the address bar or history. */
export function withoutGmailParams(params: URLSearchParams): Record<string, string> {
  const rest = Object.fromEntries(params);
  for (const k of ["gmail", "code", "state", "email", "reason"]) delete rest[k];
  return rest;
}
