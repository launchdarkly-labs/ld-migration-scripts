import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyVanishedFlags } from "./archived_propagation.ts";

Deno.test("classifyVanishedFlags splits recorded flags missing from the extraction into archived and deleted", () => {
  const result = classifyVanishedFlags({
    manifestKeys: ["live-a", "live-b", "gone-archived", "gone-deleted"],
    extractedKeys: ["live-a", "live-b", "new-flag"],
    archivedKeys: ["gone-archived", "never-migrated-archived"],
  });
  assertEquals(result, {
    archived: ["gone-archived"],
    deleted: ["gone-deleted"],
  });
});

Deno.test("classifyVanishedFlags leaves flags present in the extraction alone even when archived there", () => {
  // --include-archived puts archived flags in the flag list; the flag loop syncs their lifecycle itself
  const result = classifyVanishedFlags({
    manifestKeys: ["archived-but-extracted"],
    extractedKeys: ["archived-but-extracted"],
    archivedKeys: ["archived-but-extracted"],
  });
  assertEquals(result, { archived: [], deleted: [] });
});

Deno.test("classifyVanishedFlags respects includeFlags and excludeFlags", () => {
  const input = {
    manifestKeys: ["a", "b", "c"],
    extractedKeys: [] as string[],
    archivedKeys: ["a", "b", "c"],
  };
  assertEquals(
    classifyVanishedFlags({ ...input, includeFlags: "b, c" }).archived,
    ["b", "c"],
  );
  assertEquals(
    classifyVanishedFlags({ ...input, excludeFlags: "a" }).archived,
    ["b", "c"],
  );
  assertEquals(
    classifyVanishedFlags({ ...input, includeFlags: " , " }).archived,
    ["a", "b", "c"],
  );
});

Deno.test("classifyVanishedFlags returns sorted keys and handles an empty manifest", () => {
  assertEquals(
    classifyVanishedFlags({
      manifestKeys: ["z", "y"],
      extractedKeys: [],
      archivedKeys: ["z", "y"],
    }).archived,
    ["y", "z"],
  );
  assertEquals(
    classifyVanishedFlags({
      manifestKeys: [],
      extractedKeys: ["a"],
      archivedKeys: [],
    }),
    { archived: [], deleted: [] },
  );
});
