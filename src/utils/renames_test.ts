import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRenameMap,
  destinationCollisions,
  flagDestination,
  flagDestinationName,
  hasErrors,
  KeyResolver,
  manifestRenames,
  parseRenameCsv,
  renameCheckReport,
  renameCheckReportCsvRows,
  type RenameIssueCode,
  type SourceInventory,
  translatePrerequisites,
  validateRenameMapAgainstManifest,
  validateRenameMapStatic,
} from "./renames.ts";
import { isValidResourceKey } from "./keys.ts";

const mapOf = (csv: string) => {
  const { rows, issues } = parseRenameCsv(csv);
  const built = buildRenameMap(rows, "map.csv");
  return { map: built.map, issues: [...issues, ...built.issues] };
};
const codes = (issues: { code: RenameIssueCode }[]) =>
  issues.map((i) => i.code).sort();

const inv = (over: Partial<SourceInventory> = {}): SourceInventory => ({
  flagKeys: ["flag-1", "flag-2", "parent", "child"],
  ...over,
});

Deno.test("parseRenameCsv reads quoted values, a BOM, CRLF and extra columns", () => {
  const { map, issues } = mapOf(
    '﻿Type,KEY,new_key,new_name,note\r\nflag,flag-1,Allow-x-y,"Allow X, Y","a, note"\r\n',
  );
  assertEquals(issues, []);
  assertEquals(map.flags.get("flag-1"), {
    key: "Allow-x-y",
    name: "Allow X, Y",
    line: 2,
  });
});

Deno.test("parseRenameCsv skips empty and no-op rows and treats new_key = key as unchanged", () => {
  const { map } = mapOf(
    "type,key,new_key,new_name\nflag,flag-1,flag-1,\n,,,\nflag,flag-2,,\n",
  );
  assertEquals(map.flags.size, 0);
});

Deno.test("parseRenameCsv reports a missing header column, a bad type and a segment row", () => {
  assertEquals(codes(parseRenameCsv("key,new_key\nflag-1,x\n").issues), [
    "BAD_HEADER",
  ]);
  assertEquals(
    codes(parseRenameCsv("type,key,new_key\nflg,flag-1,x\n").issues),
    ["BAD_TYPE"],
  );
  // Segments are not renamed: a segment row stops the run instead of being silently ignored
  const segment = parseRenameCsv("type,key,new_key\nsegment,beta,b2\n");
  assertEquals(codes(segment.issues), ["BAD_TYPE"]);
  assertEquals(segment.rows, []);
});

Deno.test("buildRenameMap rejects a repeated row", () => {
  const { issues } = mapOf("type,key,new_key\nflag,flag-1,a\nflag,flag-1,b\n");
  assertEquals(codes(issues), ["DUPLICATE_ROW"]);
});

Deno.test("isValidResourceKey follows LaunchDarkly's key rule", () => {
  assertEquals(isValidResourceKey("Allow-blueprint-seamless-learning"), true);
  assertEquals(isValidResourceKey("a.b_c-1"), true);
  assertEquals(isValidResourceKey("-starts-with-dash"), false);
  assertEquals(isValidResourceKey("has space"), false);
  assertEquals(isValidResourceKey("x".repeat(257)), false);
});

Deno.test("validateRenameMapStatic: invalid key, duplicate new key, and a new key another source flag keeps", () => {
  const { map } = mapOf(
    "type,key,new_key\nflag,flag-1,bad key\nflag,parent,same\nflag,child,same\nflag,flag-2,flag-1x\n",
  );
  assertEquals(codes(validateRenameMapStatic(map, inv())), [
    "DUPLICATE_NEW_KEY",
    "INVALID_KEY",
  ]);
  const taken = mapOf("type,key,new_key\nflag,flag-1,flag-2\n").map;
  assertEquals(codes(validateRenameMapStatic(taken, inv())), [
    "NEW_KEY_IS_SOURCE_KEY",
  ]);
});

Deno.test("validateRenameMapStatic allows a swap but warns", () => {
  const { map } = mapOf(
    "type,key,new_key\nflag,flag-1,flag-2\nflag,flag-2,flag-1\n",
  );
  const issues = validateRenameMapStatic(map, inv());
  assertEquals(hasErrors(issues), false);
  assertEquals(codes(issues), ["CHAIN_OR_SWAP", "CHAIN_OR_SWAP"]);
});

Deno.test("validateRenameMapStatic warns on an unknown key", () => {
  const { map } = mapOf("type,key,new_key\nflag,nope,x\n");
  assertEquals(codes(validateRenameMapStatic(map, inv())), [
    "UNKNOWN_SOURCE_KEY",
  ]);
});

Deno.test("validateRenameMapAgainstManifest: a recorded copy must keep its key", () => {
  const { map } = mapOf(
    "type,key,new_key\nflag,flag-1,Allow-x\nflag,flag-2,Allow-y\n",
  );
  const manifest = {
    flags: { "flag-1": { destKey: "Allow-x" }, "flag-2": {} },
  };
  // flag-1 matches; flag-2 was migrated as "flag-2" but the map now renames it
  assertEquals(codes(validateRenameMapAgainstManifest(map, manifest, inv())), [
    "MANIFEST_MISMATCH",
  ]);
  // Dropping the row of a flag renamed earlier (or given a conflict prefix) is a mismatch too, and says how to keep it
  const dropped = validateRenameMapAgainstManifest(
    mapOf("type,key\n").map,
    manifest,
    inv(),
  );
  assertEquals(codes(dropped), ["MANIFEST_MISMATCH"]);
  assertEquals(
    dropped[0].message.includes('set new_key to "Allow-x" to keep that copy'),
    true,
  );
});

Deno.test("destinationCollisions: own copy passes, foreign or other-owned keys fail", () => {
  const { map } = mapOf(
    "type,key,new_key\nflag,flag-1,Allow-x\nflag,flag-2,Allow-y\nflag,parent,Allow-z\n",
  );
  const existing = { flags: new Set(["Allow-x", "Allow-y", "Allow-z"]) };
  const manifest = {
    flags: { "flag-1": { destKey: "Allow-x" }, child: { destKey: "Allow-y" } },
  };
  assertEquals(codes(destinationCollisions(map, inv(), existing, manifest)), [
    "DEST_EXISTS_FOREIGN", // parent → Allow-z exists, owned by nobody
    "DEST_OWNED_BY_OTHER", // flag-2 → Allow-y is child's copy
  ]);
});

Deno.test("destinationCollisions flags a key an aborted run may have created", () => {
  const { map } = mapOf("type,key,new_key\nflag,flag-1,Allow-x\n");
  const issues = destinationCollisions(
    map,
    inv(),
    { flags: new Set() },
    undefined,
    new Set(["Allow-x"]),
  );
  assertEquals(codes(issues), ["DEST_UNRESOLVED"]);
  // --adopt-unresolved: the aborted run's copy may exist in the destination; it is taken over, not refused
  assertEquals(
    destinationCollisions(
      map,
      inv(),
      { flags: new Set(["Allow-x"]) },
      undefined,
      new Set(["Allow-x"]),
      true,
    ),
    [],
  );
});

Deno.test("KeyResolver: recorded key, then map, then source; names from the map", () => {
  const { map } = mapOf(
    "type,key,new_key,new_name\nflag,flag-1,Allow-x,Allow X\n",
  );
  const r = new KeyResolver(map, {
    flags: { "flag-2": { destKey: "prefixed-flag-2" } },
  }, ["flag-1", "flag-2", "parent"]);
  assertEquals(r.flagKey("flag-1"), "Allow-x");
  assertEquals(r.flagKey("flag-2"), "prefixed-flag-2");
  assertEquals(r.flagKey("parent"), "parent");
  assertEquals(r.flagName("flag-1", "Flag 1"), "Allow X");
  assertEquals(r.flagName("parent", "Parent"), "Parent");
  assertEquals(r.flagSource("Allow-x"), "flag-1");
  assertEquals(r.isFlagRenamed("parent"), false);
});

Deno.test("manifestRenames keeps map renames, not conflict-prefix keys", () => {
  assertEquals(
    manifestRenames({
      "flag-1": { destKey: "Allow-x", renamedByMap: true },
      "flag-2": { destKey: "us-flag-2" }, // conflict prefix
      "flag-3": { destKey: "Allow-z", destName: "Allow Z" }, // written before renamedByMap
      parent: {},
    }),
    {
      flags: {
        "flag-1": { destKey: "Allow-x" },
        "flag-3": { destKey: "Allow-z" },
      },
    },
  );
  assertEquals(
    manifestRenames({ "flag-2": { destKey: "us-flag-2" } }),
    undefined,
  );
  // Without the map, references to renamed flags still follow their new keys
  const r = new KeyResolver(
    undefined,
    manifestRenames({
      parent: { destKey: "Release-parent", renamedByMap: true },
    }),
  );
  assertEquals(
    translatePrerequisites(
      [{ key: "parent", variation: 0 }],
      (k) => r.flagKey(k),
    ),
    [{ key: "Release-parent", variation: 0 }],
  );
});

Deno.test("flagDestinationName: map name, emptied new_name back to source, recorded name without a map", () => {
  const { map } = mapOf(
    "type,key,new_key,new_name\nflag,flag-1,Allow-x,Allow X\nflag,flag-2,Allow-y,\n",
  );
  const entry = { destKey: "Allow-y", destName: "Old Name" };
  assertEquals(flagDestinationName(map, "flag-1", undefined), "Allow X");
  assertEquals(flagDestinationName(map, "flag-2", entry), undefined);
  assertEquals(flagDestinationName(undefined, "flag-2", entry), "Old Name");
  assertEquals(flagDestinationName(undefined, "flag-3", undefined), undefined);
});

Deno.test("flagDestination applies the map and adopts only unrecorded renamed keys left by an aborted run", () => {
  const { map } = mapOf(
    "type,key,new_key,new_name\nflag,flag-1,Allow-x,Allow X\n",
  );
  const resolver = new KeyResolver(map, undefined);
  const fresh = { key: "flag-1", name: "Flag 1", recorded: false };
  const base = { sourceKey: "flag-1", map, resolver, unresolved: ["Allow-x"] };
  assertEquals(flagDestination({ ...base, recorded: fresh }), {
    key: "Allow-x",
    name: "Allow X",
    recorded: false,
    adopted: false,
  });
  assertEquals(
    flagDestination({ ...base, recorded: fresh, adopt: true }).adopted,
    true,
  );
  // A recorded copy is never "adopted"; a key not left by an aborted run isn't either
  assertEquals(
    flagDestination({
      ...base,
      recorded: { ...fresh, recorded: true },
      adopt: true,
    }).adopted,
    false,
  );
  assertEquals(
    flagDestination({ ...base, recorded: fresh, adopt: true, unresolved: [] })
      .adopted,
    false,
  );
  // No map and no resolver: the recorded destination, with a name an earlier map recorded
  assertEquals(
    flagDestination({
      sourceKey: "flag-1",
      recorded: { key: "Allow-x", name: "Flag 1", recorded: true },
      entry: { destKey: "Allow-x", destName: "Allow X" },
    }),
    { key: "Allow-x", name: "Allow X", recorded: true, adopted: false },
  );
});

Deno.test("translatePrerequisites rewrites only prerequisite keys, without mutating", () => {
  const prereqs = [{ key: "parent", variation: 0 }];
  assertEquals(
    translatePrerequisites(
      prereqs,
      (k) => (k === "parent" ? "Allow-parent" : k),
    ),
    [{ key: "Allow-parent", variation: 0 }],
  );
  assertEquals(prereqs[0].key, "parent");
});

Deno.test("renameCheckReport explains why a run stopped, errors first", () => {
  const report = renameCheckReport([
    { severity: "warning", code: "CHAIN_OR_SWAP", message: "w", line: 2 },
    {
      severity: "error",
      code: "DEST_EXISTS_FOREIGN",
      message: "e",
      type: "flag",
      key: "flag-1",
      line: 5,
    },
  ], {
    sourceProject: "src",
    destinationProject: "dst",
    renameMap: "m.csv",
    dryRun: true,
    checkedAt: "t",
  });
  assertEquals(report.outcome, "stopped");
  assertEquals(report.summary, {
    errors: 1,
    warnings: 1,
    byCode: { CHAIN_OR_SWAP: 1, DEST_EXISTS_FOREIGN: 1 },
  });
  assertEquals(report.issues.map((i) => i.code), [
    "DEST_EXISTS_FOREIGN",
    "CHAIN_OR_SWAP",
  ]);
  assertEquals(renameCheckReportCsvRows(report)[0], {
    severity: "error",
    code: "DEST_EXISTS_FOREIGN",
    line: "5",
    type: "flag",
    key: "flag-1",
    message: "e",
  });
  assertEquals(
    renameCheckReport([], {
      sourceProject: "s",
      destinationProject: "d",
      renameMap: "m",
      dryRun: false,
    }).outcome,
    "passed",
  );
});
