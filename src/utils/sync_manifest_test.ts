import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  abortMarker,
  adoptUnresolved,
  assertManifestComplete,
  recordedDestination,
  manifestDestinationFlagKeys,
  ownEntry,
  readSyncManifest,
  retainIncompleteMarker,
  retireDeletedFlags,
  type SyncManifest,
  syncManifestPath,
  withExtraDestKeys,
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

Deno.test("manifestDestinationFlagKeys prefers destKey over the source key and includes adopted copies", () => {
  assertEquals(manifestDestinationFlagKeys(manifest), ["imported-shared", "only-payroll"]);
  const withExtra: SyncManifest = {
    ...manifest,
    flags: { ...manifest.flags, shared: { ...manifest.flags.shared, extraDestKeys: ["shared"] } },
  };
  assertEquals(manifestDestinationFlagKeys(withExtra), ["imported-shared", "shared", "only-payroll"]);
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

Deno.test("abortMarker keeps gaps found during a recovery run that aborts again", () => {
  const incomplete = { reason: "aborted", at: "2026-10-16T09:00:00.000Z" };
  const first: SyncManifest = { ...manifest, flags: { a: { version: 1, environments: {} } }, incomplete };
  const run = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: ["b"], conflictedSegments: [] };
  // Prompt-mode retry prefixes the unrecorded "b", then aborts on another flag
  const next = { flags: { a: first.flags.a, b: { version: 1, environments: {}, destKey: "imported-b" } } };
  const second = abortMarker(first, { reason: "aborted again", at: "2026-10-16T09:30:00.000Z" }, run, next);
  assertEquals(second, { reason: "aborted again", at: "2026-10-16T09:30:00.000Z", unresolved: { flags: ["b"], segments: [] } });
  // A clean incremental retry after the second abort still keeps the marker
  const afterSecond: SyncManifest = { ...manifest, ...next, incomplete: second };
  const clean = { ...run, conflictedFlags: [] };
  assertEquals(retainIncompleteMarker(afterSecond, clean, next), second);
  // The first abort of all has no previous marker and no conflicts: just the reason
  assertEquals(abortMarker(manifest, incomplete, clean, { flags: manifest.flags }), incomplete);
});

Deno.test("recordedDestination reuses this migration's earlier copy on a rerun, renamed or not", () => {
  const source = { key: "foo", name: "Foo" };
  assertEquals(recordedDestination(undefined, source, "imported-"), { key: "foo", name: "Foo", recorded: false });
  // Recorded under its own key: a prefix-enabled rerun updates it instead of creating imported-foo
  assertEquals(recordedDestination({}, source, "imported-"), { key: "foo", name: "Foo", recorded: true });
  assertEquals(
    recordedDestination({ destKey: "imported-foo" }, source, "imported-"),
    { key: "imported-foo", name: "imported-Foo", recorded: true },
  );
  // A different prefix than the one used before keeps the recorded key and the source name
  assertEquals(
    recordedDestination({ destKey: "imported-foo" }, source, "legacy-"),
    { key: "imported-foo", name: "Foo", recorded: true },
  );
});

Deno.test("adoptUnresolved records untracked originals as extra copies, which clears the marker and reaches revert", () => {
  const incomplete = { reason: "aborted", at: "2026-10-16T09:00:00.000Z", unresolved: { flags: ["b"], segments: ["production/seg"] } };
  // After recovery: b was prefixed to imported-b, seg to imported-seg; the originals are still untracked
  const previous: SyncManifest = {
    ...manifest,
    flags: { a: { version: 1, environments: {} }, b: { version: 1, environments: {}, destKey: "imported-b" } },
    segments: { production: { seg: { version: 1, destKey: "imported-seg" } } },
    incomplete,
  };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  const entries: { flags: SyncManifest["flags"]; segments: NonNullable<SyncManifest["segments"]> } = {
    flags: { a: { version: 1, environments: {} }, b: { version: 2, environments: {}, destKey: "imported-b" } },
    segments: { production: { seg: { version: 2, destKey: "imported-seg" } } },
  };
  // Without adoption an unfiltered clean rerun cannot clear the marker: every run targets the prefixed copies
  assertEquals(retainIncompleteMarker(previous, clean, entries), incomplete);

  assertEquals(adoptUnresolved(previous, entries), { flags: ["b"], segments: ["production/seg"] });
  assertEquals(entries.flags.b.extraDestKeys, ["b"]);
  assertEquals(entries.segments.production.seg.extraDestKeys, ["seg"]);
  assertEquals(retainIncompleteMarker(previous, clean, entries), undefined, "adopted copies are mapped, marker clears");
  // Revert then removes both copies
  assertEquals(manifestDestinationFlagKeys({ ...manifest, ...entries }), ["a", "imported-b", "b"]);
  // Adopting again is a no-op; a key without a matching entry stays unresolved
  assertEquals(adoptUnresolved({ ...previous, incomplete }, entries), { flags: [], segments: [] });
  const filtered = { flags: { a: entries.flags.a }, segments: {} };
  assertEquals(adoptUnresolved(previous, filtered), { flags: [], segments: [] });
  assertEquals(retainIncompleteMarker(previous, { ...clean, flagScopeFiltered: true }, filtered), incomplete);
});

Deno.test("ownEntry ignores inherited members of the manifest records", () => {
  const flags: SyncManifest["flags"] = { a: { version: 1, environments: {} } };
  assertEquals(ownEntry(flags, "a")?.version, 1);
  assertEquals(ownEntry(flags, "constructor"), undefined);
  assertEquals(ownEntry(flags, "toString"), undefined);
  assertEquals(ownEntry(undefined, "a"), undefined);
});

Deno.test("withExtraDestKeys keeps adopted copies when an entry is rebuilt by a rerun", () => {
  const previous = { version: 1, environments: {}, destKey: "imported-b", extraDestKeys: ["b"] };
  const rebuilt: SyncManifest["flags"][string] = { version: 2, environments: {}, destKey: "imported-b" };
  assertEquals(withExtraDestKeys(rebuilt, previous, "b"), { ...rebuilt, extraDestKeys: ["b"] });
  // Dedupes and never lists the entry's own main destination key
  assertEquals(
    withExtraDestKeys({ version: 2, environments: {}, extraDestKeys: ["b", "x"] }, { extraDestKeys: ["x", "b", "y"] }, "b"),
    { version: 2, environments: {}, extraDestKeys: ["x", "y"] },
  );
  assertEquals(withExtraDestKeys(rebuilt, undefined, "b"), rebuilt);
  assertEquals(withExtraDestKeys(rebuilt, { destKey: "imported-b" }, "b"), rebuilt);
});

Deno.test("abortMarker records the destination keys of writes still in flight", () => {
  const previous: SyncManifest = { ...manifest, flags: { a: { version: 1, environments: {} } } };
  // c triggered the abort while b, prefixed to imported-b, was still being written and had no entry yet
  const run = {
    flagScopeFiltered: false,
    failedWrites: false,
    conflictedFlags: ["b"],
    conflictedSegments: [],
    pendingDestKeys: { flags: ["b", "imported-b"], segments: [] },
  };
  const marker = abortMarker(previous, { reason: "aborted", at: "2026-10-16T09:00:00.000Z" }, run, { flags: previous.flags });
  assertEquals(marker.unresolved, { flags: ["b", "imported-b"], segments: [] });
  // A clean overwrite retry that records b under its own key still leaves imported-b untracked
  const after: SyncManifest = { ...previous, incomplete: marker };
  const clean = { ...run, conflictedFlags: [], pendingDestKeys: undefined };
  const recordedB = { flags: { ...previous.flags, b: { version: 1, environments: {} } } };
  assertEquals(retainIncompleteMarker(after, clean, recordedB), { ...marker, unresolved: { flags: ["imported-b"], segments: [] } });
  // Adopting imported-b as b's extra copy closes the gap; the prefix tells which source key it belongs to
  const entries: { flags: SyncManifest["flags"] } = { flags: { ...previous.flags, b: { version: 1, environments: {} } } };
  const left = { ...after, incomplete: { ...marker, unresolved: { flags: ["imported-b"], segments: [] } } };
  assertEquals(adoptUnresolved(left, entries), { flags: [], segments: [] }, "unknown prefix: no owner");
  assertEquals(adoptUnresolved(left, entries, "imported-"), { flags: ["imported-b"], segments: [] });
  assertEquals(entries.flags.b.extraDestKeys, ["imported-b"]);
  assertEquals(retainIncompleteMarker(after, clean, entries), undefined);
});

Deno.test("retireDeletedFlags drops entries whose copies a revert deleted and keeps surviving copies", () => {
  const before: SyncManifest = {
    ...manifest,
    flags: {
      a: { version: 1, environments: {} },
      b: { version: 1, environments: {}, destKey: "imported-b", extraDestKeys: ["b"] },
      c: { version: 1, environments: {}, destKey: "imported-c", extraDestKeys: ["c"] },
      d: { version: 1, environments: {} },
    },
  };
  // a and both copies of b deleted; c's prefixed copy failed to delete; d was not touched
  const after = retireDeletedFlags(before, ["a", "imported-b", "b", "c"]);
  assertEquals(Object.keys(after.flags), ["c", "d"]);
  assertEquals(after.flags.c, { version: 1, environments: {}, destKey: "imported-c" });
  assertEquals(after.flags.d, before.flags.d);
  assertEquals(manifestDestinationFlagKeys(after), ["imported-c", "d"]);
  // Everything deleted: an authoritative empty inventory, not a missing manifest
  assertEquals(retireDeletedFlags(before, manifestDestinationFlagKeys(before)).flags, {});
  // A surviving extra copy becomes the main copy
  assertEquals(
    retireDeletedFlags(before, ["imported-c"]).flags.c,
    { version: 1, environments: {} },
    "c survives under its own key",
  );
});
