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
    archivedInList: [],
  });
});

Deno.test("classifyVanishedFlags lists archived flags present in the extraction separately", () => {
  // --include-archived puts archived flags in the flag list; the flag loop archives their primary copy,
  // so they are not "vanished", but their adopted extra copies still need archiving
  const result = classifyVanishedFlags({
    manifestKeys: ["archived-but-extracted", "live"],
    extractedKeys: ["archived-but-extracted", "live"],
    archivedKeys: ["archived-but-extracted"],
  });
  assertEquals(result, {
    archived: [],
    deleted: [],
    archivedInList: ["archived-but-extracted"],
  });
  // include/exclude scope applies to that list too
  assertEquals(
    classifyVanishedFlags({
      manifestKeys: ["a", "b"],
      extractedKeys: ["a", "b"],
      archivedKeys: ["a", "b"],
      excludeFlags: "b",
    }).archivedInList,
    ["a"],
  );
});

Deno.test("classifyVanishedFlags leaves the adopted copies of a date-skipped archived flag alone", () => {
  // --since skipped the flag in the flag loop, so its primary copy was not archived this run; archiving
  // only its adopted copies would split the flag's copies, so it is not listed
  const result = classifyVanishedFlags({
    manifestKeys: ["skipped", "processed", "gone"],
    extractedKeys: ["skipped", "processed"],
    archivedKeys: ["skipped", "processed", "gone"],
    skippedKeys: ["skipped"],
  });
  assertEquals(result, {
    archived: ["gone"],
    deleted: [],
    archivedInList: ["processed"],
  });
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
    { archived: [], deleted: [], archivedInList: [] },
  );
});
