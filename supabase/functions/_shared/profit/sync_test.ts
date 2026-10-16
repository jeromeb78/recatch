// The files in this folder are generated from web/src/lib; fail if someone edits one side without re-running the sync.
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("profit lib copies match web/src/lib (node scripts/sync-profit-lib.mjs)", async () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "scripts/sync-profit-lib.mjs", "--check"], cwd: root }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr));
});
