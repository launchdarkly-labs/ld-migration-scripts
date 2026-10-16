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

Deno.test("retainIncompleteMarker: an aborted run's marker survives until a clean unfiltered run reconciles every conflict", () => {
  const incomplete = { reason: 'aborted: flag "c" already exists (--on-conflict abort)', at: "2026-10-16T09:00:00.000Z" };
  // The aborted run recorded "a"; its concurrent create of "b" finished without an entry
  const aborted: SyncManifest = {
    ...manifest,
    flags: { a: { version: 1, environments: {} } },
    segments: { production: { seg: { version: 1 } } },
    incomplete,
  };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };

  assertEquals(retainIncompleteMarker(manifest, clean), undefined, "no marker to keep");
  assertEquals(retainIncompleteMarker(aborted, clean), undefined, "a clean unfiltered run closes the gap");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, flagScopeFiltered: true }), incomplete, "filtered run");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, failedWrites: true }), incomplete, "failed writes");
  // Retry with --on-conflict skip or prefix: "b" exists but has no entry, so it may be the unrecorded write
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedFlags: ["b"] }), incomplete, "unrecorded flag conflict");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedFlags: ["a"] }), undefined, "recorded flag conflict");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedSegments: ["production/other"] }), incomplete, "unrecorded segment conflict");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedSegments: ["test/seg"] }), incomplete, "same key, unrecorded environment");
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedSegments: ["production/seg"] }), undefined, "recorded segment conflict");
});
