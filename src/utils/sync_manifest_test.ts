import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  abortMarker,
  adoptUnresolved,
  assertManifestComplete,
  emptyRecord,
  legacySegmentEntries,
  recordedDestination,
  manifestDestinationFlagKeys,
  markerAfterRun,
  ownEntry,
  readSyncManifest,
  retainIncompleteMarker,
  retireDeletedFlags,
  segmentEnvironmentMismatches,
  stampIdentity,
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
  const seg = (sourceEnv: string, key: string, destEnv = sourceEnv) => ({ sourceEnv, key, destEnv });
  assertEquals(retainIncompleteMarker(aborted, { ...clean, conflictedSegments: [seg("production", "seg")] }, same), undefined, "recorded segment");
  assertEquals(
    retainIncompleteMarker(aborted, { ...clean, conflictedSegments: [seg("test", "seg")] }, same),
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
    segments: { production: { seg: { version: 1, destKey: "imported-seg", destEnv: "production" } } },
    incomplete,
  };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  const entries: { flags: SyncManifest["flags"]; segments: NonNullable<SyncManifest["segments"]> } = {
    flags: { a: { version: 1, environments: {} }, b: { version: 2, environments: {}, destKey: "imported-b" } },
    segments: { production: { seg: { version: 2, destKey: "imported-seg", destEnv: "production" } } },
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
  // A surviving extra copy becomes the main copy, with its cached versions dropped: reruns only kept the
  // primary in sync, so the next --incremental run must re-sync the promoted copy in full
  assertEquals(
    retireDeletedFlags(before, ["imported-c"]).flags.c,
    { version: 0, lastModified: undefined, environments: {} },
    "c survives under its own key and is re-synced",
  );
  // No promotion: the primary survives and its versions are kept
  assertEquals(retireDeletedFlags(before, ["c"]).flags.c, { version: 1, environments: {}, destKey: "imported-c" });
});

Deno.test("segmentEnvironmentMismatches flags entries whose destination environment changed", () => {
  const previous: SyncManifest = {
    ...manifest,
    segments: {
      prod: { seg: { version: 1, destEnv: "staging" }, other: { version: 1, destEnv: "staging" } },
      test: { t: { version: 1 } },
    },
  };
  // Same mapping as recorded: fine; prod now mapped to production: both prod entries mismatch
  assertEquals(segmentEnvironmentMismatches(previous, (e) => ({ prod: "staging", test: "test" })[e]), []);
  assertEquals(
    segmentEnvironmentMismatches(previous, (e) => ({ prod: "production", test: "test" })[e]),
    [
      'prod/seg: recorded in destination environment "staging", mapping now targets "production"',
      'prod/other: recorded in destination environment "staging", mapping now targets "production"',
    ],
  );
  // An unselected source environment is not checked; a legacy entry (no destEnv) is not judged offline
  assertEquals(segmentEnvironmentMismatches(previous, (e) => ({ test: "qa" })[e]), []);
  assertEquals(segmentEnvironmentMismatches(null, () => "x"), []);
  // Legacy entries are listed for verification against the environment the mapping targets now
  assertEquals(legacySegmentEntries(previous, (e) => ({ prod: "production", test: "qa" })[e]), [
    { sourceEnv: "test", key: "t", destKey: "t", destEnv: "qa" },
  ]);
  assertEquals(legacySegmentEntries(previous, (e) => ({ prod: "production" })[e]), []);
});

Deno.test("readSyncManifest refuses a manifest written for another destination and accepts a legacy one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const stamped: SyncManifest = { ...manifest, destDomain: "app.launchdarkly.com", destAccountId: "acct-1" };
    await Deno.writeTextFile(syncManifestPath("payroll", "new-project", dir), JSON.stringify(stamped));
    const same = { domain: "app.launchdarkly.com", accountId: "acct-1" };
    assertEquals(await readSyncManifest("payroll", "new-project", dir, same), stamped);
    assertEquals(await readSyncManifest("payroll", "new-project", dir, { domain: "app.launchdarkly.com" }), stamped, "unknown account is not checked");
    await assertRejects(() => readSyncManifest("payroll", "new-project", dir, { domain: "app.eu.launchdarkly.com", accountId: "acct-1" }), Error, "destination domain app.launchdarkly.com, not app.eu.launchdarkly.com");
    await assertRejects(() => readSyncManifest("payroll", "new-project", dir, { domain: "app.launchdarkly.com", accountId: "acct-2" }), Error, "destination account acct-1, not acct-2");
    // A manifest from an older version has no identity: returned as is for the caller to warn about
    await Deno.writeTextFile(syncManifestPath("payroll", "new-project", dir), JSON.stringify(manifest));
    const legacy = await readSyncManifest("payroll", "new-project", dir, same);
    assertEquals(legacy?.destDomain, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a flag named __proto__ survives manifest rebuilds as an own entry", () => {
  const parsed = JSON.parse('{"__proto__": {"version": 1, "environments": {}}, "a": {"version": 1, "environments": {}}}') as SyncManifest["flags"];
  const before: SyncManifest = { ...manifest, flags: parsed };
  const after = retireDeletedFlags(before, ["a"]);
  assertEquals(Object.keys(after.flags), ["__proto__"]);
  // (an object literal with a "__proto__" key would set a prototype, so compare the serialized form)
  assertEquals(JSON.stringify(after.flags), '{"__proto__":{"version":1,"environments":{}}}');
  assertEquals(manifestDestinationFlagKeys(after), ["__proto__"]);
  const record = emptyRecord<number>();
  record["__proto__"] = 1;
  assertEquals(Object.keys(record), ["__proto__"]);
});


Deno.test("markerAfterRun raises a marker when failed writes left resources without an entry", () => {
  const previous: SyncManifest = { ...manifest, flags: { a: { version: 1, environments: {} } } };
  const next = { flags: { a: previous.flags.a } };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  // b's create succeeded but a later patch threw: no entry, flagged as failed, possibly written
  const failed = { ...clean, failedWrites: true, pendingDestKeys: { flags: ["b"], segments: [] } };
  const marker = markerAfterRun(previous, failed, next, "2026-10-16T09:00:00.000Z");
  assertEquals(marker?.unresolved, { flags: ["b"], segments: [] });
  assertEquals(marker?.reason.includes("1 failed write(s)"), true);
  // A failure that kept its entry (flag-level patch failed after the entry was written) needs no marker
  assertEquals(markerAfterRun(previous, { ...clean, failedWrites: true }, next, "x"), undefined);
  assertEquals(markerAfterRun(previous, clean, next, "x"), undefined);
  // The retry that records b clears it; a retry that only prefixes b keeps it
  const after: SyncManifest = { ...previous, incomplete: marker };
  assertEquals(markerAfterRun(after, clean, { flags: { ...next.flags, b: { version: 1, environments: {} } } }, "x"), undefined);
  assertEquals(
    markerAfterRun(after, { ...clean, conflictedFlags: ["b"] }, { flags: { ...next.flags, b: { version: 1, environments: {}, destKey: "imported-b" } } }, "x"),
    marker,
  );
});

Deno.test("stampIdentity keeps the previous account stamp when the lookup fails", () => {
  const stamped: SyncManifest = { ...manifest, destDomain: "app.launchdarkly.com", destAccountId: "acct-1" };
  assertEquals(stampIdentity(stamped, { domain: "app.launchdarkly.com" }), { destDomain: "app.launchdarkly.com", destAccountId: "acct-1" });
  assertEquals(stampIdentity(stamped, { domain: "app.launchdarkly.com", accountId: "acct-1" }), { destDomain: "app.launchdarkly.com", destAccountId: "acct-1" });
  assertEquals(stampIdentity(null, { domain: "app.eu.launchdarkly.com" }), { destDomain: "app.eu.launchdarkly.com" });
  assertEquals(stampIdentity(manifest, { domain: "app.launchdarkly.com", accountId: "acct-9" }), { destDomain: "app.launchdarkly.com", destAccountId: "acct-9" });
});

Deno.test("a freshly raised marker does not list ordinary foreign conflicts as adoption candidates", () => {
  const previous: SyncManifest = { ...manifest, flags: { a: { version: 1, environments: {} } } };
  const next = { flags: { a: previous.flags.a } };
  // No earlier marker: 20 foreign keys were skipped/prefixed and one create was left with an unknown outcome
  const run = {
    flagScopeFiltered: false,
    failedWrites: true,
    conflictedFlags: ["customer-1", "customer-2"],
    conflictedSegments: [{ sourceEnv: "production", key: "their-seg", destEnv: "production" }],
    pendingDestKeys: { flags: ["b"], segments: [] },
  };
  assertEquals(markerAfterRun(previous, run, next, "x")?.unresolved, { flags: ["b"], segments: [] });
  assertEquals(abortMarker(previous, { reason: "aborted", at: "x" }, run, next).unresolved, { flags: ["b"], segments: [] });
  // Recovering from an earlier incomplete run, the same conflicts may be its unrecorded writes and are listed
  const aborted: SyncManifest = { ...previous, incomplete: { reason: "aborted", at: "x" } };
  assertEquals(
    retainIncompleteMarker(aborted, { ...run, pendingDestKeys: undefined }, next)?.unresolved,
    { flags: ["customer-1", "customer-2"], segments: ["production/their-seg"] },
  );
});

Deno.test("unresolved segments are keyed by destination environment, so a changed mapping cannot close the gap", () => {
  const previous: SyncManifest = { ...manifest, flags: {} };
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  // prod -> staging: the create of seg in staging may have succeeded before a later step threw
  const marker = markerAfterRun(previous, { ...clean, failedWrites: true, pendingDestKeys: { flags: [], segments: ["staging/seg"] } }, { flags: {} }, "x");
  assertEquals(marker?.unresolved, { flags: [], segments: ["staging/seg"] });
  const after: SyncManifest = { ...previous, incomplete: marker };
  // Retrying with prod -> production records seg in production: staging/seg stays untracked
  const inProduction = { flags: {}, segments: { prod: { seg: { version: 1, destEnv: "production" } } } };
  assertEquals(retainIncompleteMarker(after, clean, inProduction), marker);
  assertEquals(adoptUnresolved(after, inProduction), { flags: [], segments: [] }, "no entry in staging to adopt into");
  // Retrying with the original mapping records seg in staging and closes the gap
  const inStaging = { flags: {}, segments: { prod: { seg: { version: 1, destEnv: "staging" } } } };
  assertEquals(retainIncompleteMarker(after, clean, inStaging), undefined);
  // A prefixed copy in staging adopts the original under its source entry, matched through the environment
  const prefixed: { flags: SyncManifest["flags"]; segments: NonNullable<SyncManifest["segments"]> } = {
    flags: {},
    segments: { prod: { seg: { version: 1, destEnv: "staging", destKey: "imported-seg" } } },
  };
  assertEquals(retainIncompleteMarker(after, clean, prefixed), marker);
  assertEquals(adoptUnresolved(after, prefixed), { flags: [], segments: ["staging/seg"] });
  assertEquals(prefixed.segments.prod.seg.extraDestKeys, ["seg"]);
  assertEquals(retainIncompleteMarker(after, clean, prefixed), undefined);
  // A conflict while recovering is recorded under the environment the copy is in
  assertEquals(
    retainIncompleteMarker(after, { ...clean, conflictedSegments: [{ sourceEnv: "prod", key: "other", destEnv: "staging" }] }, inStaging)?.unresolved,
    { flags: [], segments: ["staging/other"] },
  );
});

Deno.test("an unverified legacy segment entry neither resolves nor adopts a gap in any environment", () => {
  const clean = { flagScopeFiltered: false, failedWrites: false, conflictedFlags: [], conflictedSegments: [] };
  const marker = { reason: "aborted", at: "x", unresolved: { flags: [], segments: ["prod/seg"] } };
  const previous: SyncManifest = { ...manifest, flags: {}, incomplete: marker };
  // A legacy entry prod/seg without destEnv (unselected this run, so never verified) may actually live in staging
  const legacy = { flags: {}, segments: { prod: { seg: { version: 1 } } } };
  assertEquals(retainIncompleteMarker(previous, clean, legacy), marker, "unverified entry does not close the gap");
  assertEquals(adoptUnresolved(previous, legacy), { flags: [], segments: [] });
  // The same entry once verified in prod resolves it
  const verified = { flags: {}, segments: { prod: { seg: { version: 1, destEnv: "prod" } } } };
  assertEquals(retainIncompleteMarker(previous, clean, verified), undefined);
});
