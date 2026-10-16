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
  const { patches: out, removed } = stripRulesReferencingSegment(patches, "dev", "public-sector-users");
  assertEquals(removed, ['rule "segment"']);
  assertEquals((out[1].value as unknown[]).length, 2);
  assertEquals((out[2].value as unknown[]).length, 3); // other env untouched
  assertEquals(out[0], patches[0]);
});
