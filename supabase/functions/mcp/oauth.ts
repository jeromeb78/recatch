// Minimal OAuth 2.1 authorization server for MCP clients (Claude custom connectors):
// dynamic client registration, authorization code + PKCE (S256), refresh-token rotation.
// The consent screen lives in the web app (/oauth/authorize) and calls `approve` with the user's session.
import { adminClient, base64UrlEncode, env, json, sha256Hex, userFromRequest } from "../_shared/utils.ts";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_S = 600;
export const SCOPE = "receipts";

export const appUrl = () => env("APP_URL").replace(/\/+$/, "");
export const resourceUrl = () => `${appUrl()}/mcp`;

function randomToken(prefix: string): string {
  return prefix + base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

/* ---------- discovery ---------- */

export function protectedResourceMetadata(): Response {
  return json({
    resource: resourceUrl(),
    authorization_servers: [appUrl()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Receipt Catcher",
  });
}

export function authorizationServerMetadata(): Response {
  const base = appUrl();
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

/* ---------- dynamic client registration (RFC 7591) ---------- */

export async function register(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const uris: unknown = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http://localhost).");
  }
  const id = randomToken("rcc_").slice(0, 36);
  const name = typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
  const { error } = await adminClient().from("oauth_clients").insert({ id, client_name: name, redirect_uris: uris });
  if (error) throw error;
  return json({
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  }, 201);
}

/** Public info for the consent screen. */
export async function clientInfo(url: URL): Promise<Response> {
  const id = url.searchParams.get("client_id") ?? "";
  const { data } = await adminClient().from("oauth_clients").select("client_name, redirect_uris").eq("id", id).maybeSingle();
  if (!data) return oauthError("invalid_client", "Unknown app. Remove the connector and add it again.", 404);
  return json({ client_name: data.client_name, redirect_uris: data.redirect_uris });
}

/* ---------- consent result (called by the web app with the user's session) ---------- */

export async function approve(req: Request): Promise<Response> {
  const user = await userFromRequest(req);
  if (!user) return json({ error: "Sign in first" }, 401);
  const b = await req.json().catch(() => ({}));
  const clientId = String(b.client_id ?? "");
  const redirectUri = String(b.redirect_uri ?? "");
  const state = typeof b.state === "string" ? b.state : null;

  const { data: client } = await adminClient().from("oauth_clients").select("redirect_uris").eq("id", clientId).maybeSingle();
  if (!client) return oauthError("invalid_client", "Unknown app. Remove the connector and add it again.");
  // Never redirect anywhere the app didn't register.
  if (!client.redirect_uris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri is not registered for this app.");

  const target = new URL(redirectUri);
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", appUrl());

  if (b.decision === "deny") {
    target.searchParams.set("error", "access_denied");
    return json({ redirect_to: target.toString() });
  }
  if (b.code_challenge_method !== "S256" || typeof b.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(b.code_challenge)) {
    target.searchParams.set("error", "invalid_request");
    target.searchParams.set("error_description", "PKCE with S256 is required");
    return json({ redirect_to: target.toString() });
  }

  const code = randomToken("rcx_");
  const { error } = await adminClient().from("oauth_codes").insert({
    code_hash: await sha256Hex(code),
    client_id: clientId,
    user_id: user.id,
    redirect_uri: redirectUri,
    code_challenge: b.code_challenge,
    scope: SCOPE,
    expires_at: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
  });
  if (error) throw error;
  target.searchParams.set("code", code);
  return json({ redirect_to: target.toString() });
}

/* ---------- token endpoint ---------- */

async function issue(userId: string, clientId: string) {
  const access = randomToken("rca_");
  const refresh = randomToken("rcr_");
  const now = Date.now();
  const { error } = await adminClient().from("oauth_tokens").insert({
    user_id: userId,
    client_id: clientId,
    access_hash: await sha256Hex(access),
    refresh_hash: await sha256Hex(refresh),
    scope: SCOPE,
    access_expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
  });
  if (error) throw error;
  const res = json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function token(req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  const p: Record<string, string> = type.includes("application/json")
    ? await req.json().catch(() => ({}))
    : Object.fromEntries(new URLSearchParams(await req.text()));

  // Public clients send client_id in the body; accept HTTP Basic too.
  let clientId = p.client_id ?? "";
  const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i);
  if (!clientId && basic) clientId = decodeURIComponent(atob(basic[1]).split(":")[0] ?? "");
  const db = adminClient();

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier) return oauthError("invalid_request", "code and code_verifier are required");
    const hash = await sha256Hex(p.code);
    // Single use: claim the code atomically.
    const { data: row } = await db.from("oauth_codes").update({ used_at: new Date().toISOString() })
      .eq("code_hash", hash).is("used_at", null).select("*").maybeSingle();
    if (!row) return oauthError("invalid_grant", "Code is invalid or was already used");
    if (Date.parse(row.expires_at) < Date.now()) return oauthError("invalid_grant", "Code expired");
    if (clientId && row.client_id !== clientId) return oauthError("invalid_grant", "Code was issued to another client");
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri mismatch");
    if ((await s256(p.code_verifier)) !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");
    return await issue(row.user_id, row.client_id);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return oauthError("invalid_request", "refresh_token is required");
    const { data: row } = await db.from("oauth_tokens").update({ revoked_at: new Date().toISOString() })
      .eq("refresh_hash", await sha256Hex(p.refresh_token)).is("revoked_at", null).select("*").maybeSingle();
    if (!row) return oauthError("invalid_grant", "Refresh token is invalid or revoked");
    if (row.refresh_expires_at && Date.parse(row.refresh_expires_at) < Date.now()) return oauthError("invalid_grant", "Refresh token expired");
    if (clientId && row.client_id !== clientId) return oauthError("invalid_grant", "Token was issued to another client");
    return await issue(row.user_id, row.client_id);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/* ---------- resource server ---------- */

/** User id for a valid, unexpired, unrevoked access token, else null. */
export async function userFromAccessToken(req: Request): Promise<string | null> {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(rca_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const db = adminClient();
  const { data } = await db.from("oauth_tokens").select("id, user_id, access_expires_at, last_used_at")
    .eq("access_hash", await sha256Hex(m[1])).is("revoked_at", null).maybeSingle();
  if (!data || Date.parse(data.access_expires_at) < Date.now()) return null;
  if (!data.last_used_at || Date.now() - Date.parse(data.last_used_at) > 5 * 60_000) {
    await db.from("oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  }
  return data.user_id as string;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "Connect Receipt Catcher again" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
      "WWW-Authenticate": `Bearer resource_metadata="${appUrl()}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
    },
  });
}
