import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripRulesReferencingSegment, unknownSegmentFromError } from "./utils.ts";

Deno.test("unknownSegmentFromError parses the API error body", () => {
  assertEquals(unknownSegmentFromError('{"code":"invalid_request","message":"unknown segment \\"public-sector-users\\""}'), "public-sector-users");
  assertEquals(unknownSegmentFromError('unknown segment "beta"'), "beta");
  assertEquals(unknownSegmentFromError('{"code":"invalid_request","message":"something else"}'), null);
});

Deno.test("stripRulesReferencingSegment removes only rules that reference the segment, in that env", () => {
  const rules = [
    { description: "country", clauses: [{ attribute: "country", op: "in", values: ["DE"] }], variation: 0 },
    { description: "segment", clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["public-sector-users"] }], variation: 1 },
    { clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["other"] }], variation: 1 },
  ];
  const patches = [
    { op: "replace", path: "/environments/dev/on", value: false },
    { op: "replace", path: "/environments/dev/rules", value: rules },
    { op: "replace", path: "/environments/stage/rules", value: rules },
  ];
  const { patches: out, removed, unsafe } = stripRulesReferencingSegment(patches, "dev", "public-sector-users");
  assertEquals(removed, ['rule "segment"']);
  assertEquals(unsafe, []);
  assertEquals((out[1].value as unknown[]).length, 2);
  assertEquals((out[2].value as unknown[]).length, 3); // other env untouched
  assertEquals(out[0], patches[0]);
});

Deno.test("stripRulesReferencingSegment keeps OR'd and negated clauses and reports them as unsafe", () => {
  const rules = [
    { description: "mixed", clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["missing", "existing"] }], variation: 0 },
    { description: "negated", clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["missing"], negate: true }], variation: 0 },
    { description: "plain", clauses: [{ attribute: "segmentMatch", op: "segmentMatch", values: ["missing"] }], variation: 1 },
  ];
  const patches = [{ op: "replace", path: "/environments/dev/rules", value: rules }];
  const { patches: out, removed, unsafe } = stripRulesReferencingSegment(patches, "dev", "missing");
  assertEquals(removed, ['rule "plain"']);
  assertEquals(unsafe, ['rule "mixed"', 'rule "negated"']);
  assertEquals((out[0].value as any[]).map((r) => r.description), ["mixed", "negated"]);
});

Deno.test("stripRulesReferencingSegment accepts paths with or without a leading slash", () => {
  const rules = [{ clauses: [{ op: "segmentMatch", values: ["s"] }] }];
  const a = stripRulesReferencingSegment([{ op: "replace", path: "environments/dev/rules", value: rules }], "dev", "s");
  const b = stripRulesReferencingSegment([{ op: "replace", path: "/environments/dev/rules", value: rules }], "dev", "s");
  assertEquals(a.removed.length, 1);
  assertEquals(b.removed.length, 1);
});
