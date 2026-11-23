// deno test supabase/functions/inbound-email
import { assertEquals } from "jsr:@std/assert@1";

const serve = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {} });
const { webhookSecret } = await import("./index.ts");
// deno-lint-ignore no-explicit-any
(Deno as any).serve = serve;

const URL_ = "https://x.supabase.co/functions/v1/inbound-email";

Deno.test("reads the webhook secret from Basic auth, whatever the user name", () => {
  const req = new Request(URL_, { headers: { Authorization: `Basic ${btoa("postmark:s3cr:et")}` } });
  assertEquals(webhookSecret(req, true), "s3cr:et");
  assertEquals(webhookSecret(req, false), "s3cr:et");
});

Deno.test("the legacy ?secret= parameter only works while allowed", () => {
  const req = new Request(`${URL_}?secret=abc`);
  assertEquals(webhookSecret(req, true), "abc");
  assertEquals(webhookSecret(req, false), "");
});

Deno.test("Basic auth wins over the query parameter, and bad Basic values give nothing", () => {
  assertEquals(webhookSecret(new Request(`${URL_}?secret=abc`, { headers: { Authorization: `Basic ${btoa("u:right")}` } }), true), "right");
  assertEquals(webhookSecret(new Request(URL_, { headers: { Authorization: "Basic !!!" } }), true), "");
});
