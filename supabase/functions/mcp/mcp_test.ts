// End-to-end test of the OAuth flow and MCP protocol against an in-memory PostgREST stand-in.
// deno test --allow-env --allow-net=localhost supabase/functions/mcp
import { assert, assertEquals } from "jsr:@std/assert@1";

const SUPABASE = "http://localhost:54321";
Deno.env.set("SUPABASE_URL", SUPABASE);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("APP_URL", "https://app.example.com");

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  oauth_clients: [], oauth_codes: [], oauth_tokens: [],
  receipts: [
    { id: "r1", user_id: USER, source_message_id: "ext:www.walmart.com:orders/2000123" },
    { id: "r2", user_id: OTHER, source_message_id: "ext:www.walmart.com:orders/2000999" },
  ],
  line_items: [{ id: "li-other", user_id: OTHER, description: "x" }],
};

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, cond] of params) {
    if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(col)) continue;
    const [op, ...rest] = cond.split(".");
    const val = rest.join(".");
    if (op === "eq" && String(row[col]) !== val) return false;
    if (op === "is" && val === "null" && row[col] != null) return false;
    if (op === "in" && !val.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(row[col]))) return false;
  }
  return true;
}

// Minimal PostgREST + GoTrue for the calls the server makes.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (!url.href.startsWith(SUPABASE)) return realFetch(input, init);
  if (url.pathname === "/auth/v1/user") {
    return req.headers.get("authorization") === "Bearer user-jwt"
      ? Response.json({ id: USER, email: "me@example.com", aud: "authenticated" })
      : Response.json({ message: "invalid" }, { status: 401 });
  }
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = db[table] ?? (db[table] = []);
  const single = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const reply = (out: Row[]) => {
    if (!single) return Response.json(out);
    if (out.length === 1) return Response.json(out[0]);
    return Response.json({ code: "PGRST116", message: "0 rows", details: "", hint: null }, { status: 406 });
  };
  if (req.method === "GET" || req.method === "HEAD") return reply(rows.filter((r) => matches(r, url.searchParams)));
  if (req.method === "POST") {
    const body = await req.json();
    const items = (Array.isArray(body) ? body : [body]).map((b) => ({ id: crypto.randomUUID(), ...b }));
    rows.push(...items);
    return (req.headers.get("prefer") ?? "").includes("return=representation") ? reply(items) : new Response(null, { status: 201 });
  }
  if (req.method === "PATCH") {
    const patch = await req.json();
    const hit = rows.filter((r) => matches(r, url.searchParams));
    hit.forEach((r) => Object.assign(r, patch));
    return (req.headers.get("prefer") ?? "").includes("return=representation") ? reply(hit) : new Response(null, { status: 204 });
  }
  return new Response("unsupported", { status: 500 });
};

// Load the server without starting a listener.
const serve = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = () => ({});
const { handler } = await import("./index.ts");
// deno-lint-ignore no-explicit-any
(Deno as any).serve = serve;

const call = (path: string, init?: RequestInit) => handler(new Request(`https://ref.supabase.co/functions/v1/mcp${path}`, init));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = "test-verifier-" + "x".repeat(50);
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let clientId = "", access = "", refresh = "";

const rpc = (body: unknown, token = access) =>
  call("", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

Deno.test("discovery metadata points at the app domain", async () => {
  const pr = await (await call("/.well-known/oauth-protected-resource")).json();
  assertEquals(pr.resource, "https://app.example.com/mcp");
  assertEquals(pr.authorization_servers, ["https://app.example.com"]);
  const as = await (await call("/.well-known/oauth-authorization-server")).json();
  assertEquals(as.token_endpoint, "https://app.example.com/oauth/token");
  assertEquals(as.code_challenge_methods_supported, ["S256"]);
});

Deno.test("unauthenticated MCP request gets 401 with resource metadata", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "nope");
  assertEquals(res.status, 401);
  assert(res.headers.get("www-authenticate")?.includes('resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"'));
});

Deno.test("dynamic client registration", async () => {
  const bad = await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }) });
  assertEquals(bad.status, 400);
  const res = await call("/oauth/register", {
    method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assertEquals(res.status, 201);
  clientId = (await res.json()).client_id;
  assert(clientId.startsWith("rcc_"));
});

Deno.test("consent: unregistered redirect refused, approve returns code", async () => {
  const headers = { authorization: "Bearer user-jwt", "content-type": "application/json" };
  const evil = await call("/oauth/approve", { method: "POST", headers, body: JSON.stringify({ client_id: clientId, redirect_uri: "https://evil.com/cb" }) });
  assertEquals(evil.status, 400);
  const anon = await call("/oauth/approve", { method: "POST", body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT }) });
  assertEquals(anon.status, 401);
  const res = await call("/oauth/approve", {
    method: "POST", headers,
    body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  const to = new URL((await res.json()).redirect_to);
  assertEquals(to.origin + to.pathname, REDIRECT);
  assertEquals(to.searchParams.get("state"), "s1");
  const code = to.searchParams.get("code")!;

  const form = (p: Record<string, string>) => call("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString(),
  });
  const wrong = await form({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier-" + "y".repeat(40), client_id: clientId, redirect_uri: REDIRECT });
  assertEquals((await wrong.json()).error, "invalid_grant");
  // A failed attempt still burns the code (single use), so approve again for the real exchange.
  const res2 = await call("/oauth/approve", {
    method: "POST", headers,
    body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, state: "s2", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  const code2 = new URL((await res2.json()).redirect_to).searchParams.get("code")!;
  const ok = await form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  assertEquals(ok.status, 200);
  const tok = await ok.json();
  assertEquals(tok.token_type, "Bearer");
  access = tok.access_token;
  refresh = tok.refresh_token;
  const replay = await form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  assertEquals((await replay.json()).error, "invalid_grant");
  // Stored hashed, never in plain text.
  assert(!JSON.stringify(db.oauth_tokens).includes(access));
});

Deno.test("MCP handshake, tools and user scoping", async () => {
  const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).json();
  assertEquals(init.result.protocolVersion, "2025-06-18");
  assertEquals(init.result.serverInfo.name, "receipt-catcher");
  assertEquals((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names, ["add_receipt", "check_imported", "search_receipts", "get_receipt", "spending_summary", "inventory_costs", "update_line_item"]);
  assert(list.result.tools.every((t: { handler?: unknown }) => t.handler === undefined));

  const check = await (await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "check_imported", arguments: { urls: ["https://www.walmart.com/orders/2000123", "https://www.walmart.com/orders/2000999", "https://www.walmart.com/orders/2000555"] } },
  })).json();
  // 2000999 belongs to another user, so it must not count as imported.
  assertEquals(check.result.structuredContent.already_imported, ["https://www.walmart.com/orders/2000123"]);
  assertEquals(check.result.structuredContent.not_imported.length, 2);

  const upd = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_line_item", arguments: { id: "li-other", woo_sku: "HACK" } } })).json();
  assertEquals(upd.result.isError, true);
  assertEquals(db.line_items[0].woo_sku, undefined);

  const bad = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "add_receipt", arguments: { text: "short" } } })).json();
  assertEquals(bad.result.isError, true);

  const unknown = await (await rpc({ jsonrpc: "2.0", id: 6, method: "does/not/exist" })).json();
  assertEquals(unknown.error.code, -32601);
});

Deno.test("refresh rotation: old refresh token stops working", async () => {
  const form = (p: Record<string, string>) => call("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString(),
  });
  const r1 = await form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
  assertEquals(r1.status, 200);
  const next = await r1.json();
  const again = await form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
  assertEquals((await again.json()).error, "invalid_grant");
  // The rotated-out access token is revoked too; the new one works.
  assertEquals((await rpc({ jsonrpc: "2.0", id: 9, method: "ping" })).status, 401);
  assertEquals((await (await rpc({ jsonrpc: "2.0", id: 9, method: "ping" }, next.access_token)).json()).result, {});
});
