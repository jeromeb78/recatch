// POST (user JWT)           → { url } Google consent URL with an HMAC-signed state.
// GET ?code=…&state=…        → Google's redirect: store the refresh token, bounce back to the app.
import { exchangeCode, GOOGLE_SCOPES, redirectUri, userEmail } from "../_shared/gmail.ts";
import { adminClient, corsHeaders, env, json, signPayload, userFromRequest, verifyPayload } from "../_shared/utils.ts";

interface State {
  uid: string;
  exp: number;
  n: string;
}

function backToApp(params: Record<string, string>): Response {
  const url = new URL("/settings", env("APP_URL"));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method === "POST") {
      const user = await userFromRequest(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const state = await signPayload(
        { uid: user.id, exp: Date.now() + 10 * 60_000, n: crypto.randomUUID() } satisfies State,
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
      if (params.get("error")) return backToApp({ gmail: "error", reason: params.get("error")! });

      const code = params.get("code");
      const state = await verifyPayload<State>(params.get("state") ?? "", env("OAUTH_STATE_SECRET"));
      if (!code || !state || state.exp < Date.now()) return backToApp({ gmail: "error", reason: "invalid_state" });

      const tokens = await exchangeCode(code);
      if (!tokens.refresh_token) return backToApp({ gmail: "error", reason: "no_refresh_token" });
      const email = await userEmail(tokens.access_token);

      const { error } = await adminClient().from("email_connections").upsert(
        {
          user_id: state.uid,
          provider: "gmail",
          email,
          refresh_token: tokens.refresh_token,
          status: "active",
          last_error: null,
        },
        { onConflict: "user_id,provider,email" },
      );
      if (error) throw error;
      return backToApp({ gmail: "connected", email });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("gmail-oauth", e);
    if (req.method === "GET") return backToApp({ gmail: "error", reason: "server_error" });
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
