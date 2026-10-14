// deno test --sloppy-imports web/tests
import { assertEquals } from "jsr:@std/assert@1";
import { parseCards, parseStores, usesScheduleC } from "../src/lib/businessInfo.ts";

Deno.test("cards keep only the last 4 digits", () => {
  assertEquals(parseCards("4242, Visa ending 1881"), ["4242", "1881"]);
  assertEquals(parseCards("4111 1111 1111 1881"), ["1881"]);
  assertEquals(parseCards("12, abc, 4242, 4242"), ["4242"]);
});

Deno.test("stores split on commas", () => {
  assertEquals(parseStores(" B&H Photo, Adorama ,, "), ["B&H Photo", "Adorama"]);
});

Deno.test("only sole props and single-member LLCs file Schedule C", () => {
  assertEquals(["sole_prop", "single_llc", "s_corp", "partnership"].map((t) => usesScheduleC({ entity_type: t as never })), [true, true, false, false]);
});
