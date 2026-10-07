// Receipt Catcher MCP server (Streamable HTTP, stateless JSON responses) + its OAuth endpoints.
// Served from the app's own domain through rewrites (see web/vercel.json):
//   /mcp                                    → this function
//   /.well-known/oauth-protected-resource   → /mcp/.well-known/oauth-protected-resource
//   /.well-known/oauth-authorization-server → /mcp/.well-known/oauth-authorization-server
//   /oauth/register, /oauth/token           → /mcp/oauth/…
// The consent page (/oauth/authorize) is a page in the web app that calls /mcp/oauth/approve.
import {
  approve, authorizationServerMetadata, clientInfo, protectedResourceMetadata, register, token, unauthorized,
  userFromAccessToken,
} from "./oauth.ts";
import { callTool, TOOLS } from "./tools.ts";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

const INSTRUCTIONS = `Receipt Catcher keeps the user's purchase receipts with line items, Woo SKUs, Schedule C tax lines and landed unit costs.
- To import order history from a store website (Walmart, Target, Amazon, …) in the user's browser: collect the order-detail URLs from the order history page, call check_imported to skip ones already captured, then for each new order open its details/receipt page, read the full visible text and call add_receipt with that text and the page URL. Go one order at a time, never change or cancel orders, and stop to ask the user if a sign-in or CAPTCHA appears.
- For a receipt email or invoice the user shares, call add_receipt with its full text.
- Use search_receipts / get_receipt / spending_summary / inventory_costs to answer questions; include the receipt link when pointing at a receipt.
- Tax lines are organizing suggestions, not tax advice.`;

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(msg: RpcRequest, userId: string) {
  const isNotification = msg.id === undefined;
  if (typeof msg !== "object" || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "Invalid request");
  }
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, …

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "receipt-catcher", title: "Receipt Catcher", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ handler: _h, ...t }) => t),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return rpcResult(msg.id, await callTool(name, userId, args));
    }
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Path after the function name, e.g. "" | "/oauth/token" | "/.well-known/oauth-protected-resource".
  const path = url.pathname.replace(/^.*?\/mcp(?=\/|$)/, "").replace(/\/+$/, "");

  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata();
  if (req.method === "GET" && (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))) {
    return authorizationServerMetadata();
  }
  if (path === "/oauth/register" && req.method === "POST") return await register(req);
  if (path === "/oauth/token" && req.method === "POST") return await token(req);
  if (path === "/oauth/client" && req.method === "GET") return await clientInfo(url);
  if (path === "/oauth/approve" && req.method === "POST") return await approve(req);

  if (path === "") {
    if (req.method !== "POST") {
      // No server-initiated streams: this server answers every POST with plain JSON.
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const userId = await userFromAccessToken(req);
    if (!userId) return unauthorized();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as RpcRequest[];
    const replies = (await Promise.all(messages.map((m) => handleRpc(m, userId)))).filter((r) => r !== null);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0]);
  }

  return new Response("Not found", { status: 404 });
}

export async function handler(req: Request): Promise<Response> {
  try {
    return withCors(await route(req));
  } catch (e) {
    console.error("mcp", e);
    return withCors(Response.json({ error: "server_error", error_description: e instanceof Error ? e.message : String(e) }, { status: 500 }));
  }
}

Deno.serve(handler);
