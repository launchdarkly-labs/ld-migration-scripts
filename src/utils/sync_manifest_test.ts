import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertManifestComplete,
  manifestDestinationFlagKeys,
  readSyncManifest,
  retainIncompleteMarker,
  type SyncManifest,
  syncManifestPath,
} from "./sync_manifest.ts";

const manifest: SyncManifest = {
  lastSyncTimestamp: "2026-10-15T10:00:00.000Z",
  sourceProject: "payroll",
  destProject: "new-project",
  flags: {
    shared: { version: 3, environments: {}, destKey: "imported-shared" },
    "only-payroll": { version: 1, environments: {} },
  },
};

Deno.test("syncManifestPath matches the file migrate writes", () => {
  assertEquals(
    syncManifestPath("payroll", "new-project"),
    "./data/launchdarkly-migrations/sync-manifest-payroll-new-project.json",
  );
  assertEquals(syncManifestPath("a", "b", "/tmp/x"), "/tmp/x/sync-manifest-a-b.json");
});

Deno.test("manifestDestinationFlagKeys prefers destKey over the source key", () => {
  assertEquals(manifestDestinationFlagKeys(manifest), ["imported-shared", "only-payroll"]);
});

Deno.test("readSyncManifest returns null when there is no manifest and parses one when there is", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readSyncManifest("payroll", "new-project", dir), null);
    await Deno.writeTextFile(syncManifestPath("payroll", "new-project", dir), JSON.stringify(manifest));
    assertEquals(await readSyncManifest("payroll", "new-project", dir), manifest);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readSyncManifest throws on an unreadable manifest instead of treating it as missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(syncManifestPath("a", "b", dir), "{not json");
    await assertRejects(() => readSyncManifest("a", "b", dir), Error, "Could not read sync manifest");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readSyncManifest rejects a manifest that records another project pair", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // "a-b" -> "c" and "a" -> "b-c" share the file name sync-manifest-a-b-c.json
    await Deno.writeTextFile(
      syncManifestPath("a", "b-c", dir),
      JSON.stringify({ ...manifest, sourceProject: "a-b", destProject: "c" }),
    );
    await assertRejects(() => readSyncManifest("a", "b-c", dir), Error, "records a-b -> c, not a -> b-c");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertManifestComplete rejects a manifest written by an aborted run and keeps a complete one", async () => {
  assertManifestComplete(manifest, "x.json");
  const aborted: SyncManifest = {
    ...manifest,
    incomplete: { reason: 'aborted: flag "c" already exists (--on-conflict abort)', at: "2026-10-16T09:00:00.000Z" },
  };
  assertThrows(() => assertManifestComplete(aborted, "x.json"), Error, "x.json is marked incomplete");
  // The marker survives a read, so revert sees it
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(syncManifestPath("payroll", "new-project", dir), JSON.stringify(aborted));
    const read = await readSyncManifest("payroll", "new-project", dir);
    assertEquals(read?.incomplete, aborted.incomplete);
    assertThrows(() => assertManifestComplete(read!, "x.json"), Error, "marked incomplete");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("retainIncompleteMarker: an aborted run's marker survives until the untracked keys are mapped by entries", () => {
  const incomplete = { reason: 'aborted: flag "c" already exists (--on-conflict abort)', at: "2026-10-16T09:00:00.000Z" };
  // The aborted run recorded "a"; its concurrent create of "b" finished without an entry
  const aborted: SyncManifest = {
    ...manifest,
    flags: { a: { version: 1, environments: {} } },
    segments: { production: { seg: { version: 1 } } },
    incomplete,
  };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  const same = { flags: aborted.flags, segments: aborted.segments };

  assertEquals(retainIncompleteMarker(manifest, clean, same), undefined, "no marker to keep");
  assertEquals(retainIncompleteMarker(aborted, clean, same), undefined, "a clean unfiltered run with nothing untracked closes the gap");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, flagScopeFiltered: true }, same), incomplete, "filtered run");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, failedWrites: true }, same), incomplete, "failed writes");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedFlags: ["a"] }, same), undefined, "conflict on a recorded key");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedSegments: ["production/seg"] }, same), undefined, "recorded segment");
  assertEquals(
    retainIncompleteMarker(aborted, { ...clean, conflictedSegments: ["test/seg"] }, same),
    { ...incomplete, unresolved: { flags: [], segments: ["test/seg"] } },
    "same key in an unrecorded environment stays untracked",
  );
});

Deno.test("retainIncompleteMarker: untracked keys persist across recovery runs until an entry maps to them", () => {
  const incomplete = { reason: "aborted", at: "2026-10-16T09:00:00.000Z" };
  const aborted: SyncManifest = { ...manifest, flags: { a: { version: 1, environments: {} } }, incomplete };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };

  // Run 1: unfiltered --on-conflict prefix; "b" exists with no entry and is renamed to imported-b
  const afterPrefix = { flags: { a: aborted.flags.a, b: { version: 1, environments: {}, destKey: "imported-b" } } };
  const marker1 = retainIncompleteMarker(aborted, { ...clean, conflictedFlags: ["b"] }, afterPrefix);
  assertEquals(marker1, { ...incomplete, unresolved: { flags: ["b"], segments: [] } });

  // Run 2: unfiltered --incremental, everything unchanged, no conflicts seen: "b" is still untracked
  const run1: SyncManifest = { ...manifest, ...afterPrefix, incomplete: marker1 };
  assertEquals(retainIncompleteMarker(run1, clean, afterPrefix), marker1, "incremental retry keeps the marker");
  // A second prefix/skip retry hits the same key, now with an entry, and still keeps it
  assertEquals(retainIncompleteMarker(run1, { ...clean, conflictedFlags: ["b"] }, afterPrefix), marker1);

  // Run 3: --on-conflict overwrite records "b" under its own key, so the gap is closed
  const afterOverwrite = { flags: { a: aborted.flags.a, b: { version: 1, environments: {} } } };
  assertEquals(retainIncompleteMarker(run1, clean, afterOverwrite), undefined, "an entry mapping to b clears the marker");
  // A filtered run that records "b" keeps the marker (other writes may still be unattempted) but drops the resolved key
  assertEquals(retainIncompleteMarker(run1, { ...clean, flagScopeFiltered: true }, afterOverwrite), incomplete);
});
