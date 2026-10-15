// deno test supabase/functions/upload-receipt
import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const serve = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {} });
const { sniff } = await import("./index.ts");
// deno-lint-ignore no-explicit-any
(Deno as any).serve = serve;

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

Deno.test("recognises receipt file types from their first bytes", () => {
  assertEquals(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)), { mime: "image/jpeg", ext: "jpg" });
  assertEquals(sniff(bytes(0x89, "PNG", 0x0d, 0x0a)), { mime: "image/png", ext: "png" });
  assertEquals(sniff(bytes("RIFF", 0, 0, 0, 0, "WEBP")), { mime: "image/webp", ext: "webp" });
  assertEquals(sniff(bytes("%PDF-1.7")), { mime: "application/pdf", ext: "pdf" });
  assertEquals(sniff(bytes(0, 0, 0, 24, "ftypheic")), { heic: true });
  assertEquals(sniff(bytes("hello world")), null);
});
