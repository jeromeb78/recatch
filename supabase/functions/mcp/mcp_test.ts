// End-to-end test of the OAuth flow and MCP protocol against an in-memory PostgREST stand-in.
// deno test --allow-env --allow-net=localhost supabase/functions/mcp
import { assert, assertEquals } from "jsr:@std/assert@1";

const SUPABASE = "http://localhost:54321";
Deno.env.set("SUPABASE_URL", SUPABASE);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("APP_URL", "https://app.example.com");

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-333333333333";
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  oauth_clients: [], oauth_codes: [], oauth_tokens: [],
  // MEMBER was invited to USER's account to see reports only.
  account_members: [{ owner_id: USER, member_id: MEMBER, permissions: { receipts: "none", reports: "view", settings: "none", team: "none" } }],
  receipts: [
    { id: "r1", user_id: USER, source_message_id: "ext:www.walmart.com:orders/2000123" },
    { id: "r2", user_id: OTHER, source_message_id: "ext:www.walmart.com:orders/2000999" },
  ],
  line_items: [{ id: "li-other", user_id: OTHER, description: "x" }],
  // A WooCommerce order paid through Stripe and shipped with Easyship, plus another user's data that must stay out.
  sales_channels: [{ id: "ch-woo", user_id: USER, kind: "woocommerce", store_url: "https://shop.example.com" }],
  payment_accounts: [{ id: "pa-1", user_id: USER, business_id: null }],
  shipping_accounts: [{ id: "sa-1", user_id: USER, business_id: null }],
  sales_orders: [
    { id: "so-1", user_id: USER, channel_id: "ch-woo", external_id: "501", order_number: "1001", order_date: "2026-03-02", status: "paid", items_total: 40,
      shipping_charged: 8, tax_collected: 3, refunded: 0, fees: 0, total: 51, business_id: null, payment_method: "stripe", payment_ref: "ch_1" },
    { id: "so-x", user_id: OTHER, channel_id: "ch-o", external_id: "9", order_number: "1001", order_date: "2026-03-02", status: "paid", items_total: 999,
      shipping_charged: 0, tax_collected: 0, refunded: 0, fees: 0, total: 999, business_id: null, payment_method: "stripe", payment_ref: "ch_9" },
  ],
  sales_lines: [
    { id: 1, order_id: "so-1", user_id: USER, sku: "ABC1", name: "Barbie Doll", quantity: 2, total: 40, sales_orders: { business_id: null, order_date: "2026-03-02" } },
    { id: 2, order_id: "so-x", user_id: OTHER, sku: "ABC1", name: "Barbie Doll", quantity: 50, total: 999, sales_orders: { business_id: null, order_date: "2026-03-02" } },
  ],
  payments: [{ id: "p-1", user_id: USER, account_id: "pa-1", external_id: "ch_1", payment_intent: "pi_1", payment_date: "2026-03-02", status: "succeeded",
    amount: 51, refunded: 0, fee: 1.78, disputed: false, description: null, order_ref: "501", site_url: "https://shop.example.com" }],
  shipments: [{ id: "sh-1", user_id: USER, account_id: "sa-1", external_id: "ESUS1", order_ref: "1001", ship_date: "2026-03-03", state: "active",
    label_cost: 9.5, courier: "USPS", tracking: "9400" }],
  sales_products: [{ user_id: USER, sku: "ABC1", name: "Barbie Doll", stock: 3, cost: 12 }],
  sku_costs: [{ user_id: USER, sku: "ABC1", unit_cost: 5, pool_id: null }],
};

const field = (row: Row, col: string): unknown => col.split(".").reduce<unknown>((v, k) => (v as Row | undefined)?.[k], row);
function test(row: Row, col: string, op: string, val: string): boolean {
  const v = field(row, col);
  if (op === "eq") return String(v) === val;
  if (op === "is") return val === "null" ? v == null : true;
  if (op === "lte") return v != null && String(v) <= val;
  if (op === "gte") return v != null && String(v) >= val;
  if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(v));
  return true;
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, cond] of params) {
    if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(col)) continue;
    if (col === "or") {
      const any = cond.replace(/^\(|\)$/g, "").split(",").some((c) => { const [k, op, ...v] = c.split("."); return test(row, k, op, v.join(".")); });
      if (!any) return false;
      continue;
    }
    const [op, ...rest] = cond.split(".");
    if (op === "not") { if (test(row, col, rest[0], rest.slice(1).join("."))) return false; continue; }
    if (!test(row, col, op, rest.join("."))) return false;
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
    const who = { "Bearer user-jwt": USER, "Bearer member-jwt": MEMBER }[req.headers.get("authorization") ?? ""];
    return who
      ? Response.json({ id: who, email: `${who.slice(0, 4)}@example.com`, aud: "authenticated" })
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
  if (req.method === "DELETE") {
    db[table] = rows.filter((r) => !matches(r, url.searchParams));
    return new Response(null, { status: 204 });
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
  assertEquals(names, [
    "add_receipt", "check_imported", "search_receipts", "get_receipt", "spending_summary", "inventory_costs", "update_line_item",
    "profit_summary", "product_profit", "stripe_reconciliation", "shipping_costs", "inventory_on_hand", "get_order", "set_sku_cost",
  ]);
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

Deno.test("profit tools: Stripe-checked sales, SKU cost, Easyship labels, scoped to the user", async () => {
  const tool = async (name: string, args: Record<string, unknown>) =>
    (await (await rpc({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name, arguments: args } })).json()).result;

  const sum = (await tool("profit_summary", { year: 2026 })).structuredContent;
  assertEquals(sum.orders, 1);
  assertEquals(sum.units_sold, 2);
  assertEquals(sum.cost_of_goods, 10); // 2 × your $5 SKU cost (beats the store's $12)
  assertEquals(sum.fees, 1.78); // Stripe's fee
  assert(sum.expenses.some((e: { line: string; amount: number }) => /Easyship/.test(e.line) && e.amount === 9.5));
  assertEquals(sum.units_sold_by_cost_source.your_cost, 2);

  const prod = (await tool("product_profit", { year: 2026, sku: "abc1" })).structuredContent;
  assertEquals(prod.products.length, 1);
  assertEquals(prod.products[0].unit_cost, 5);
  assertEquals(prod.products[0].units_sold, 2);

  const stripe = (await tool("stripe_reconciliation", { year: 2026 })).structuredContent;
  assertEquals(stripe.matched_orders, 1);
  assertEquals(stripe.stripe_payments_without_store_order.count, 0);

  const ship = (await tool("shipping_costs", { year: 2026 })).structuredContent;
  assertEquals(ship.label_spend_total, 9.5);
  assertEquals(ship.customers_paid_for_shipping, 8);
  assertEquals(ship.shipping_profit, -1.5);

  const order = (await tool("get_order", { order: "#1001" })).structuredContent;
  assertEquals(order.items[0].unit_cost, 5);
  assertEquals(order.money.fees, 1.78);
  assertEquals(order.money.shipping_labels, 9.5);
  assertEquals(order.money.profit, 51 - 3 - 1.78 - 10 - 9.5);

  const set = await tool("set_sku_cost", { sku: " abc2 ", unit_cost: 7.25 });
  assertEquals(set.structuredContent.sku, "ABC2");
  assertEquals(db.sku_costs.at(-1), { id: db.sku_costs.at(-1)!.id, user_id: USER, sku: "ABC2", unit_cost: 7.25, updated_at: db.sku_costs.at(-1)!.updated_at });
  assertEquals((await tool("set_sku_cost", { sku: "X", unit_cost: -1 })).isError, true);
  assertEquals((await tool("profit_summary", { business: "Nope" })).isError, true);
  assertEquals((await tool("get_order", { order: "424242" })).isError, true);
});

Deno.test("team member connects Claude to the owner's account with only their access", async () => {
  const approve = (account: string) => call("/oauth/approve", {
    method: "POST", headers: { authorization: "Bearer member-jwt", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, state: "m", code_challenge: challenge, code_challenge_method: "S256", account }),
  });
  assertEquals((await approve(OTHER)).status, 403); // not a member there
  const code = new URL((await (await approve(USER)).json()).redirect_to).searchParams.get("code")!;
  const tok = await (await call("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
  })).json();
  const member = tok.access_token as string;
  assertEquals(db.oauth_tokens.at(-1)!.account_id, USER);

  const names = (await (await rpc({ jsonrpc: "2.0", id: 30, method: "tools/list" }, member)).json()).result.tools.map((t: { name: string }) => t.name);
  assertEquals(names, ["inventory_costs", "profit_summary", "product_profit", "stripe_reconciliation", "shipping_costs", "inventory_on_hand", "get_order"]);
  const call2 = async (name: string, args: Record<string, unknown>) =>
    (await (await rpc({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name, arguments: args } }, member)).json()).result;
  // Sees the owner's sales, not their own (empty) account.
  assertEquals((await call2("profit_summary", { year: 2026 })).structuredContent.orders, 1);
  assertEquals((await call2("search_receipts", {})).isError, true);
  assertEquals((await call2("set_sku_cost", { sku: "ABC1", unit_cost: 1 })).isError, true);

  // Removing the member cuts Claude off on the next request.
  db.account_members = [];
  assertEquals((await rpc({ jsonrpc: "2.0", id: 32, method: "tools/list" }, member)).status, 401);
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
