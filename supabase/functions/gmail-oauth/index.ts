// POST (user JWT) {return_to?}            → { url } Google consent URL with an HMAC-signed state.
// GET ?code=…&state=…                      → Google's redirect: hand code + state back to the app, unchanged.
// POST (user JWT) {action:"finish",code,state} → the app finishes the connection: the signed-in caller must be the
//                                            user who started it, then the refresh token is stored.
//
// Why the extra hop: the state only says who *started* the flow. If the callback stored the token itself, an attacker
// could start "Connect Gmail" for their own account, send the consent link to someone else, and receive that person's
// receipt emails. Finishing with the caller's own session ties the Google account to whoever is signed in here.
import { exchangeCode, GOOGLE_SCOPES, redirectUri, userEmail } from "../_shared/gmail.ts";
import {
  adminClient, corsHeaders, env, json, publicError, signPayload, userFromRequest, verifyPayload,
} from "../_shared/utils.ts";

interface State {
  uid: string;
  exp: number;
  n: string;
  r?: string;
}

// Where the app may ask to be sent back to after Google's consent screen.
const RETURN_PATHS = ["/settings", "/welcome"];
const safeReturn = (r: unknown) =>
  typeof r === "string" && RETURN_PATHS.some((p) => r === p || r.startsWith(`${p}?`)) ? r : undefined;

function backToApp(params: Record<string, string>, returnTo = "/settings"): Response {
  const url = new URL(safeReturn(returnTo) ?? "/settings", env("APP_URL"));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method === "POST") {
      const user = await userFromRequest(req);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = await req.json().catch(() => ({}));

      if (body?.action === "finish") {
        const code = typeof body.code === "string" ? body.code : "";
        const state = await verifyPayload<State>(typeof body.state === "string" ? body.state : "", env("OAUTH_STATE_SECRET"));
        if (!code || !state || state.exp < Date.now()) {
          return json({ error: "This Gmail link expired. Click Connect Gmail again." }, 400);
        }
        if (state.uid !== user.id) {
          return json({ error: "This Gmail connection was started from a different Receipt Catcher account, so it wasn't saved." }, 403);
        }

        const tokens = await exchangeCode(code);
        if (!tokens.refresh_token) return json({ error: "Google didn't return offline access. Try connecting again." }, 400);
        const email = await userEmail(tokens.access_token);

        const db = adminClient();
        const { data: conn, error } = await db.from("email_connections").upsert(
          { user_id: user.id, provider: "gmail", email, status: "active", last_error: null },
          { onConflict: "user_id,provider,email" },
        ).select("id").single();
        if (error) throw error;
        // The refresh token is kept encrypted in Vault, never in the table itself.
        const { error: tokenError } = await db.rpc("gmail_token_set", { p_connection: conn.id, p_token: tokens.refresh_token });
        if (tokenError) throw tokenError;
        return json({ email });
      }

      const state = await signPayload(
        { uid: user.id, exp: Date.now() + 10 * 60_000, n: crypto.randomUUID(), r: safeReturn(body?.return_to) } satisfies State,
        env("OAUTH_STATE_SECRET"),
      );
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID"),
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent", // always return a refresh token
        include_granted_scopes: "true",
        state,
      }).toString();
      return json({ url: url.toString() });
    }

    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const rawState = params.get("state") ?? "";
      // Only used to pick the return page; the state is checked again (with the caller's session) when finishing.
      const state = await verifyPayload<State>(rawState, env("OAUTH_STATE_SECRET"));
      if (params.get("error")) return backToApp({ gmail: "error", reason: params.get("error")!.slice(0, 60) }, state?.r);

      const code = params.get("code");
      if (!code || !state || state.exp < Date.now()) return backToApp({ gmail: "error", reason: "invalid_state" }, state?.r);
      return backToApp({ gmail: "finish", code, state: rawState }, state.r);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    if (req.method === "GET") {
      console.error("gmail-oauth", e);
      return backToApp({ gmail: "error", reason: "server_error" });
    }
    return publicError("gmail-oauth", e);
  }
});
