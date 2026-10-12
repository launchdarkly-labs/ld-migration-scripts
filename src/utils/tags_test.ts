import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeTags } from "./tags.ts";

Deno.test("mergeTags preserves tag order and removes duplicates", () => {
  assertEquals(
    mergeTags(["source", "shared"], ["migration", "shared"], ["destination"]),
    ["source", "shared", "migration", "destination"],
  );
});

Deno.test("mergeTags accepts nullable tag groups", () => {
  assertEquals(mergeTags(null, undefined, ["migration"]), ["migration"]);
  assertEquals(mergeTags(null, undefined), []);
});
