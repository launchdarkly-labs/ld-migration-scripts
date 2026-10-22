import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { segmentMetadataPatches } from "./segment_metadata.ts";

Deno.test("segmentMetadataPatches replaces tags with the source tags when no migration tags are set", () => {
  assertEquals(
    segmentMetadataPatches(
      { name: "Germany", tags: ["dirty", "smishing"] },
      { name: "Germany", tags: ["smishing"] },
    ),
    [{ op: "replace", path: "/tags", value: ["dirty", "smishing"] }],
  );
  // a tag removed in the source is removed in the destination too
  assertEquals(
    segmentMetadataPatches({ tags: ["smishing"] }, {
      tags: ["dirty", "smishing"],
    }),
    [{ op: "replace", path: "/tags", value: ["smishing"] }],
  );
});

Deno.test("segmentMetadataPatches merges tags when migration tags are set", () => {
  assertEquals(
    segmentMetadataPatches(
      { tags: ["a"] },
      { tags: ["kept"] },
      ["migrated"],
    ),
    [{ op: "replace", path: "/tags", value: ["a", "migrated", "kept"] }],
  );
});

Deno.test("segmentMetadataPatches ignores tag order and treats a missing description as empty", () => {
  assertEquals(
    segmentMetadataPatches(
      { name: "n", description: undefined, tags: ["b", "a"] },
      { name: "n", description: "", tags: ["a", "b"] },
    ),
    [],
  );
  assertEquals(
    segmentMetadataPatches({ tags: [] }, { tags: undefined }),
    [],
  );
});

Deno.test("segmentMetadataPatches syncs name and description", () => {
  assertEquals(
    segmentMetadataPatches(
      { name: "New name", description: "Now described", tags: ["t"] },
      { name: "Old name", description: undefined, tags: ["t"] },
    ),
    [
      { op: "replace", path: "/name", value: "New name" },
      { op: "replace", path: "/description", value: "Now described" },
    ],
  );
  // a description cleared in the source is cleared in the destination
  assertEquals(
    segmentMetadataPatches({ name: "n" }, { name: "n", description: "old" }),
    [{ op: "replace", path: "/description", value: "" }],
  );
  // a source without a name never blanks the destination name
  assertEquals(segmentMetadataPatches({}, { name: "kept" }), []);
});
