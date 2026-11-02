import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { diffPayloads, rewritePayloadKeys } from "./mod.ts";

const source = {
  flags: {
    "flag-1": {
      key: "flag-1",
      prerequisites: [{ key: "parent", variation: 0 }],
      rules: [{ clauses: [{ op: "segmentMatch", values: ["beta"] }] }],
    },
    parent: { key: "parent" },
  },
  segments: { beta: { key: "beta", rules: [] } },
};
const flagKey = (k: string) =>
  ({ "flag-1": "Allow-x", parent: "Release-parent" } as Record<string, string>)[
    k
  ] ?? k;

Deno.test("rewritePayloadKeys renames flag keys and prerequisites, without changing the input", () => {
  const out = rewritePayloadKeys(source, flagKey) as any;
  assertEquals(Object.keys(out.flags).sort(), ["Allow-x", "Release-parent"]);
  assertEquals(out.flags["Allow-x"].key, "Allow-x");
  assertEquals(out.flags["Allow-x"].prerequisites, [{
    key: "Release-parent",
    variation: 0,
  }]);
  // Segments are not renamed: segment keys and segmentMatch values stay as they are
  assertEquals(out.flags["Allow-x"].rules[0].clauses[0].values, ["beta"]);
  assertEquals(Object.keys(out.segments), ["beta"]);
  assertEquals(Object.keys(source.flags), ["flag-1", "parent"]);
});

Deno.test("a renamed payload diffs as identical to its migrated copy", () => {
  const migrated = rewritePayloadKeys(source, flagKey);
  const result = diffPayloads(rewritePayloadKeys(source, flagKey), migrated, {
    includeSegments: true,
    format: "delta",
  });
  assertEquals(
    result.flags.changed + result.flags.onlyLeft + result.flags.onlyRight,
    0,
  );
  // Without the rewrite every renamed flag shows up as only in A plus only in B
  const raw = diffPayloads(source, migrated, {
    includeSegments: true,
    format: "delta",
  });
  assertEquals(raw.flags.onlyLeft, 2);
});
