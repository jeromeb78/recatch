// deno test --sloppy-imports web/tests
import { assert, assertEquals } from "jsr:@std/assert@1";
import { allows, describePerms, FULL, NONE, PRESETS, presetFor } from "../src/lib/permissions.ts";

Deno.test("edit implies view; none allows nothing", () => {
  const p = { ...NONE, receipts: "edit" as const, reports: "view" as const };
  assert(allows(p, "receipts", "view") && allows(p, "receipts", "edit"));
  assert(allows(p, "reports", "view") && !allows(p, "reports", "edit"));
  assert(!allows(p, "settings") && !allows(p, "team", "edit"));
  assert(allows(FULL, "team", "edit"));
});

Deno.test("presets round-trip and anything else is custom", () => {
  for (const p of PRESETS) assertEquals(presetFor(p.perms), p.key);
  assertEquals(presetFor({ ...NONE, settings: "view" }), "custom");
  // Only the owner may hand out team management, so exactly one preset includes it.
  assertEquals(PRESETS.filter((p) => p.perms.team === "edit").map((p) => p.key), ["admin"]);
});

Deno.test("permission summary reads naturally", () => {
  assertEquals(describePerms(NONE), "no access");
  assertEquals(describePerms({ ...NONE, receipts: "edit", reports: "view" }), "edit receipts, view reports & taxes");
  assert(describePerms(FULL).endsWith("manage team"));
});
