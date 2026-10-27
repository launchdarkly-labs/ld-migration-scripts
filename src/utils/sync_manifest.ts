/**
 * The sync manifest `migrate` writes after every real run:
 *   data/launchdarkly-migrations/sync-manifest-<sourceProject>-<destProject>.json
 *
 * It is the inventory of what the migration wrote. For every migrated flag and segment it records
 * the source version (used by --incremental) and the destination key when it differs from the source
 * key (conflict prefix); segments also record their destination environment. The file records the
 * destination domain and account it was written for. Later runs update the recorded copies, view
 * linking and the revert tool use the recorded keys to find them.
 *
 * The manifest is cumulative: a run rewrites the entries of the resources it attempted and keeps the
 * entries of resources outside its scope (include/exclude filters, --since, unselected environments,
 * migrateSegments: false). A resource whose write failed keeps its entry with its cached versions
 * cleared, so the next --incremental run retries it. A run that stops early, or whose failed writes
 * left resources without an entry, writes the manifest marked `incomplete`; revert refuses such a
 * manifest until a later run clears the marker (see markerAfterRun and adoptUnresolved). A dry run
 * never writes a manifest.
 *
 * Every entry also records the state the run left its destination copy in (`dest`), and what was
 * edited in the destination since (`targetOwned`), so reruns never overwrite destination edits; see
 * target_guard.ts.
 */

import type { FlagTargetRecord, SegmentTargetRecord } from "./target_guard.ts";

export const MIGRATION_DATA_DIR = "./data/launchdarkly-migrations";

export interface SyncManifestEnv {
  version: number;
  lastModified?: string;
}

/** dest, targetOwned and awaitingApproval protect destination edits; see target_guard.ts */
export interface SyncManifestFlag extends FlagTargetRecord {
  version: number;
  lastModified?: string;
  environments: Record<string, SyncManifestEnv>;
  /** Destination key, if it differs from the source key (e.g. conflict prefix) */
  destKey?: string;
  /** Further destination copies this migration owns, e.g. a write an aborted run left unrecorded and a later run prefixed; adopted with --adopt-unresolved */
  extraDestKeys?: string[];
}

/** dest and targetOwned protect destination edits; see target_guard.ts */
export interface SyncManifestSegment extends SegmentTargetRecord {
  version: number;
  lastModified?: number;
  /** Destination key in this environment, if it differs from the source key (e.g. conflict prefix) */
  destKey?: string;
  /** Further destination copies in this environment that this migration owns (see SyncManifestFlag.extraDestKeys) */
  extraDestKeys?: string[];
  /** Destination environment the copy lives in; always recorded since 3.4, absent in entries from older versions */
  destEnv?: string;
}

export interface SyncManifest {
  /** When the writing run finished */
  lastSyncTimestamp: string;
  /** When the writing run started; absent in manifests from older versions */
  lastRunStartedAt?: string;
  /**
   * End of the last run on a version before 3.6.0: entries without a recorded destination state count
   * as edited when the destination was modified after it (see target_guard.ts)
   */
  legacyEditCutoff?: string;
  sourceProject: string;
  destProject: string;
  /** Destination domain the manifest was written for; absent in manifests from older versions */
  destDomain?: string;
  /** Destination account the manifest was written for (caller-identity), when the token could read it */
  destAccountId?: string;
  flags: Record<string, SyncManifestFlag>;
  /** segments[sourceEnvKey][segmentKey] */
  segments?: Record<string, Record<string, SyncManifestSegment>>;
  /**
   * Set when the writing run stopped early (--on-conflict abort, unexpected phase error) or when its
   * failed writes left resources without an entry: the inventory is not exhaustive. Cleared by a later
   * run that completes without flag-scope filters (includeFlags, excludeFlags, --since), without failed
   * writes, once an entry maps to every destination key the marker lists; see retainIncompleteMarker,
   * markerAfterRun and adoptUnresolved.
   */
  incomplete?: IncompleteMarker;
}

export interface IncompleteMarker {
  reason: string;
  at: string;
  /**
   * Destination resources that may exist but that no entry maps to: writes with an unknown outcome,
   * and, while recovering, conflicts on keys without an entry (skipped or prefix-renamed), each possibly
   * the aborted run's unrecorded write. Flags by destination key; segments as
   * "<destinationEnv>/<destinationKey>", so a gap is only closed by a copy in that environment, whatever
   * mapping a later run uses. The marker is cleared only once an entry maps to every one of them.
   */
  unresolved?: { flags: string[]; segments: string[] };
}

/** The destination a run or revert talks to; a manifest is only trusted for the one it was written for. */
export interface DestinationIdentity {
  domain: string;
  accountId?: string;
}

/** A dictionary without a prototype, so keys such as "__proto__" or "constructor" are plain own entries. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function syncManifestPath(
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
): string {
  return `${baseDir}/sync-manifest-${sourceProject}-${destProject}.json`;
}

/**
 * Reads the manifest for a source/destination pair, or returns null when none exists.
 * @throws Error when the file exists but cannot be read or parsed, records a different project pair
 *   (keys containing "-" can share a file name: a-b -> c and a -> b-c both map to a-b-c), or was written
 *   for another destination domain or account than `identity`. A manifest from an older version has no
 *   destination identity and is returned as is; callers warn and the next migrate run stamps it.
 */
export async function readSyncManifest(
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
  identity?: DestinationIdentity,
): Promise<SyncManifest | null> {
  const path = syncManifestPath(sourceProject, destProject, baseDir);
  let manifest: SyncManifest;
  try {
    manifest = JSON.parse(await Deno.readTextFile(path)) as SyncManifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw new Error(
      `Could not read sync manifest ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    manifest.sourceProject !== sourceProject ||
    manifest.destProject !== destProject
  ) {
    throw new Error(
      `Sync manifest ${path} records ${manifest.sourceProject} -> ${manifest.destProject}, ` +
        `not ${sourceProject} -> ${destProject}; refusing to use its keys`,
    );
  }
  if (
    identity && manifest.destDomain && manifest.destDomain !== identity.domain
  ) {
    throw new Error(
      `Sync manifest ${path} was written for destination domain ${manifest.destDomain}, not ${identity.domain}; ` +
        `refusing to use its keys (migrating the same projects to another destination needs its own working directory)`,
    );
  }
  if (
    identity?.accountId && manifest.destAccountId &&
    manifest.destAccountId !== identity.accountId
  ) {
    throw new Error(
      `Sync manifest ${path} was written for destination account ${manifest.destAccountId}, not ${identity.accountId}; ` +
        `refusing to use its keys (migrating the same projects to another destination needs its own working directory)`,
    );
  }
  return manifest;
}

/**
 * Throws when the manifest is marked incomplete: revert must not treat it as the full inventory of what
 * the migration wrote, since a flag created just before the abort may have no entry.
 */
export function assertManifestComplete(
  manifest: SyncManifest,
  path: string,
): void {
  const marker = manifest.incomplete;
  if (!marker) return;
  const untracked = [
    ...(marker.unresolved?.flags ?? []),
    ...(marker.unresolved?.segments ?? []),
  ];
  throw new Error(
    `Sync manifest ${path} is marked incomplete (${marker.reason}, at ${marker.at}): ` +
      `a migrate run stopped before recording all of its writes` +
      (untracked.length > 0
        ? `; untracked destination resources: ${untracked.join(", ")}`
        : "") +
      `. Re-run the migration without includeFlags, excludeFlags or --since and let it complete cleanly (no failed ` +
      `writes); if untracked resources remain, verify they were created by the aborted run and re-run with ` +
      `--adopt-unresolved to record them, or revert with --no-use-source-data after checking the flags by hand.`,
  );
}

/** What a completed run did that bears on whether an earlier abort's inventory gap can be considered closed. */
export interface RunOutcome {
  /** includeFlags, excludeFlags or --since left flags unattempted */
  flagScopeFiltered: boolean;
  /** Some flag or segment write failed */
  failedWrites: boolean;
  /** Source flag keys whose destination copy already existed and was skipped or prefix-renamed */
  conflictedFlags: Iterable<string>;
  /** Segments whose destination copy already existed and was skipped or prefix-renamed: source environment and key, and the destination environment the copy is in */
  conflictedSegments: Iterable<
    { sourceEnv: string; key: string; destEnv: string }
  >;
  /**
   * Destination keys of writes whose outcome is unknown: in flight when a run aborted, or failed after
   * the create may have succeeded (flags by destination key, segments as "<destinationEnv>/<destinationKey>").
   * Each may or may not exist and none has an entry, so they stay untracked until an entry maps to them.
   * A create the API definitively rejected (4xx) is not pending: nothing was written.
   */
  pendingDestKeys?: { flags: Iterable<string>; segments: Iterable<string> };
}

/** The flag and segment entries a run is about to write. */
export type ManifestEntries = Pick<SyncManifest, "flags" | "segments">;

type DestEntry = { destKey?: string; extraDestKeys?: string[] };

/** Every destination key an entry owns: its primary copy (destKey, else the source key) and adopted extra copies. */
export const ownedKeys = (
  key: string,
  entry: DestEntry,
): string[] => [entry.destKey ?? key, ...(entry.extraDestKeys ?? [])];

/** Own-property lookup: a resource named like an Object.prototype member must not resolve to an inherited value. */
export function ownEntry<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}

/**
 * A rebuilt manifest entry with the extra destination copies its previous entry owned (adopted with
 * --adopt-unresolved) merged in, so a successful rerun does not drop them from the inventory.
 */
export function withExtraDestKeys<T extends DestEntry>(
  entry: T,
  previous: DestEntry | undefined,
  key: string,
): T {
  const main = entry.destKey ?? key;
  const extras = [
    ...new Set([
      ...(entry.extraDestKeys ?? []),
      ...(previous?.extraDestKeys ?? []),
    ]),
  ].filter((k) => k !== main);
  if (extras.length === 0) {
    const { extraDestKeys: _none, ...rest } = entry;
    return rest as T;
  }
  return { ...entry, extraDestKeys: extras };
}

const mapsTo = (
  entries: Record<string, DestEntry> | undefined,
  destKey: string,
): boolean =>
  Object.entries(entries ?? {}).some(([key, entry]) =>
    ownedKeys(key, entry).includes(destKey)
  );

type SegmentEntryLike = DestEntry & { destEnv?: string };

/**
 * Segment entries (with their source environment and key) whose copy is known to live in `destEnv`.
 * Only entries with a recorded destination environment qualify: a missing one marks an unverified entry
 * from an older version, whose copy may live anywhere, so it can neither resolve nor adopt a gap.
 */
const segmentEntriesIn = (
  segments: Record<string, Record<string, SegmentEntryLike>> | undefined,
  destEnv: string,
): Array<{ sourceEnv: string; key: string; entry: SegmentEntryLike }> => {
  const found: Array<
    { sourceEnv: string; key: string; entry: SegmentEntryLike }
  > = [];
  for (const [sourceEnv, entries] of Object.entries(segments ?? {})) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.destEnv === destEnv) found.push({ sourceEnv, key, entry });
    }
  }
  return found;
};

/** True when some segment entry owns `destKey` in destination environment `destEnv`. */
const segmentMappedTo = (
  next: ManifestEntries,
  destEnv: string,
  destKey: string,
): boolean =>
  segmentEntriesIn(next.segments, destEnv).some(({ key, entry }) =>
    ownedKeys(key, entry).includes(destKey)
  );

const splitSegmentId = (id: string): [string, string] => {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
};

/**
 * Destination resources that no entry maps to after this run: the previous marker's list, the writes
 * still in flight (`pendingDestKeys`), and, only while recovering from an earlier incomplete run, the
 * copies this run found as conflicts on keys without an entry (skipped or prefix-renamed, so left
 * untracked: each may be that run's unrecorded write). Without an earlier marker such a conflict is an
 * ordinary foreign resource and is not listed, so it is never offered for adoption. Keys an entry in
 * `next` maps to are removed. Undefined when nothing is untracked.
 */
export function unresolvedAfterRun(
  previous: SyncManifest | null,
  run: RunOutcome,
  next: ManifestEntries,
): IncompleteMarker["unresolved"] {
  const prevFlags = previous?.flags ?? {};
  const prevSegments = previous?.segments ?? {};
  const recovering = Boolean(previous?.incomplete);
  const flags = new Set(previous?.incomplete?.unresolved?.flags ?? []);
  const segments = new Set(previous?.incomplete?.unresolved?.segments ?? []);
  if (recovering) {
    for (const key of run.conflictedFlags) {
      if (!Object.hasOwn(prevFlags, key)) flags.add(key);
    }
    for (const { sourceEnv, key, destEnv } of run.conflictedSegments) {
      // The existing copy sits under the source key in the destination environment
      if (
        !Object.hasOwn(prevSegments, sourceEnv) ||
        !Object.hasOwn(prevSegments[sourceEnv], key)
      ) segments.add(`${destEnv}/${key}`);
    }
  }
  // Writes in flight at an abort have no entry yet, whatever their outcome
  for (const key of run.pendingDestKeys?.flags ?? []) flags.add(key);
  for (const id of run.pendingDestKeys?.segments ?? []) segments.add(id);
  const unresolvedFlags = [...flags].filter((key) => !mapsTo(next.flags, key))
    .sort();
  const unresolvedSegments = [...segments].filter((id) => {
    const [destEnv, destKey] = splitSegmentId(id);
    return !segmentMappedTo(next, destEnv, destKey);
  }).sort();
  return unresolvedFlags.length > 0 || unresolvedSegments.length > 0
    ? { flags: unresolvedFlags, segments: unresolvedSegments }
    : undefined;
}

/**
 * The `incomplete` marker a run must keep from the previous manifest, or undefined when the run may
 * clear it. The aborted run's writes that finished without an entry surface later as conflicts on
 * keys the manifest does not map to; skipping or prefix-renaming them leaves the existing copy
 * untracked, so its destination key is recorded in the marker and persists across runs. The marker
 * is cleared only by a run without flag-scope filters or failed writes, once an entry in `next` maps
 * to every recorded destination key (an overwrite records it; an unchanged incremental retry does not).
 */
export function retainIncompleteMarker(
  previous: SyncManifest | null,
  run: RunOutcome,
  next: ManifestEntries,
): IncompleteMarker | undefined {
  const marker = previous?.incomplete;
  if (!marker) return undefined;
  const unresolved = unresolvedAfterRun(previous, run, next);
  if (!run.flagScopeFiltered && !run.failedWrites && !unresolved) {
    return undefined;
  }
  const { unresolved: _previous, ...rest } = marker;
  return unresolved ? { ...rest, unresolved } : rest;
}

/**
 * The marker for a run that stops early: the given reason, plus every destination resource still
 * untracked after this run (the previous marker's list and this run's skipped or prefix-renamed
 * conflicts on keys without an entry), so a later abort does not lose gaps found during recovery.
 */
export function abortMarker(
  previous: SyncManifest | null,
  incomplete: Pick<IncompleteMarker, "reason" | "at">,
  run: RunOutcome,
  next: ManifestEntries,
): IncompleteMarker {
  const unresolved = unresolvedAfterRun(previous, run, next);
  return unresolved ? { ...incomplete, unresolved } : { ...incomplete };
}

/**
 * The marker a completed run must write, or undefined. An existing marker is retained by the rules of
 * retainIncompleteMarker. Without one, failed writes that left attempted resources without an entry
 * (`run.pendingDestKeys`: the create may have succeeded before a later step threw) raise a new marker
 * listing those destination keys, so revert does not trust an inventory that omits an existing copy.
 */
export function markerAfterRun(
  previous: SyncManifest | null,
  run: RunOutcome,
  next: ManifestEntries,
  at: string,
): IncompleteMarker | undefined {
  const retained = retainIncompleteMarker(previous, run, next);
  if (retained) return retained;
  if (!run.failedWrites) return undefined;
  const pending = [
    ...(run.pendingDestKeys?.flags ?? []),
    ...(run.pendingDestKeys?.segments ?? []),
  ];
  if (pending.length === 0) return undefined;
  return abortMarker(
    previous,
    {
      reason:
        `${pending.length} failed write(s) left destination resources without an entry`,
      at,
    },
    run,
    next,
  );
}

/**
 * The destination identity to stamp on the manifest being written: the current domain, and the current
 * account when the caller-identity lookup worked, else the account the previous manifest recorded, so a
 * failed lookup never erases an existing account stamp.
 */
export function stampIdentity(
  previous: SyncManifest | null,
  identity: DestinationIdentity,
): Pick<SyncManifest, "destDomain" | "destAccountId"> {
  const accountId = identity.accountId ?? previous?.destAccountId;
  return {
    destDomain: identity.domain,
    ...(accountId ? { destAccountId: accountId } : {}),
  };
}

/**
 * The destination key and name a rerun should write a source resource under. Any previous manifest
 * entry names this migration's own earlier copy: under the source key, or under another key after a
 * conflict-prefix rename. The rerun updates that copy instead of treating it as a conflict, so a
 * prefix-enabled rerun does not create another prefixed duplicate that the manifest would then track
 * in place of the first one.
 */
export function recordedDestination(
  entry: { destKey?: string } | undefined,
  source: { key: string; name: string },
  conflictPrefix: string | undefined,
): { key: string; name: string; recorded: boolean } {
  if (!entry) return { key: source.key, name: source.name, recorded: false };
  const destKey = entry.destKey ?? source.key;
  const name = conflictPrefix && destKey === `${conflictPrefix}${source.key}`
    ? `${conflictPrefix}${source.name}`
    : source.name;
  return { key: destKey, name, recorded: true };
}

/**
 * Explicit reconciliation of an incomplete marker (--adopt-unresolved): every destination resource the
 * marker lists as untracked is recorded as a further copy (extraDestKeys) of the source resource it
 * belongs to, so the marker can clear and revert removes it too. The owner is the entry with the same
 * source key, or, with `conflictPrefix`, the entry whose prefixed key it is (an unrecorded prefix retry).
 * The caller has verified by hand that those resources were created by the aborted run. Returns what
 * was adopted; keys without a matching entry (e.g. filtered out this run) stay unresolved.
 */
export function adoptUnresolved(
  previous: SyncManifest | null,
  entries: ManifestEntries,
  conflictPrefix?: string,
): { flags: string[]; segments: string[] } {
  const adopted = { flags: [] as string[], segments: [] as string[] };
  const unresolved = previous?.incomplete?.unresolved;
  if (!unresolved) return adopted;
  // The source key an untracked destination key belongs to: itself, or itself minus the conflict prefix
  const ownerKey = <T>(
    record: Record<string, T> | undefined,
    destKey: string,
  ): string | undefined => {
    if (ownEntry(record, destKey)) return destKey;
    if (conflictPrefix && destKey.startsWith(conflictPrefix)) {
      const unprefixed = destKey.slice(conflictPrefix.length);
      if (ownEntry(record, unprefixed)) return unprefixed;
    }
    return undefined;
  };
  const adopt = (
    record: Record<string, DestEntry> | undefined,
    destKey: string,
  ): boolean => {
    const key = ownerKey(record, destKey);
    const entry = key === undefined ? undefined : record![key];
    if (!entry || ownedKeys(key!, entry).includes(destKey)) return false;
    entry.extraDestKeys = [...(entry.extraDestKeys ?? []), destKey];
    return true;
  };
  for (const destKey of unresolved.flags) {
    if (adopt(entries.flags, destKey)) adopted.flags.push(destKey);
  }
  for (const id of unresolved.segments) {
    // Candidates are the entries whose copy lives in that destination environment, keyed by source key
    const [destEnv, destKey] = splitSegmentId(id);
    const candidates: Record<string, SegmentEntryLike> = emptyRecord();
    for (const { key, entry } of segmentEntriesIn(entries.segments, destEnv)) {
      candidates[key] = entry;
    }
    if (adopt(candidates, destKey)) adopted.segments.push(id);
  }
  return adopted;
}

/**
 * The manifest after a revert deleted destination flags: entries whose every owned copy was deleted are
 * removed, so a later rerun does not take a flag another source creates under the same key for its own
 * recorded copy; an entry with surviving copies (a failed deletion) keeps them, promoting the first one
 * to its main destination key. The manifest itself stays, possibly with no flags, as the authoritative
 * inventory for the pair.
 */
/**
 * Ownership after a revert promotes `remaining[0]` (an adopted copy) to the main copy: surviving
 * adopted copies keep theirs, and a promoted copy that was edited in the destination belongs to it
 * entirely (like a copy recreated there: no field or environment is written).
 */
function promotedOwnership(
  owned: SyncManifestFlag["targetOwned"],
  remaining: string[],
): Pick<SyncManifestFlag, "targetOwned"> {
  const copies = (owned?.copies ?? []).filter((k) =>
    remaining.slice(1).includes(k)
  );
  const promotedOwned = Boolean(owned?.copies?.includes(remaining[0]));
  if (!promotedOwned && copies.length === 0) return {};
  return {
    targetOwned: {
      ...(promotedOwned ? { flag: true, deleted: true } : {}),
      ...(copies.length > 0 ? { copies } : {}),
    },
  };
}

export function retireDeletedFlags(
  manifest: SyncManifest,
  deletedDestKeys: Iterable<string>,
): SyncManifest {
  const deleted = new Set(deletedDestKeys);
  const flags: SyncManifest["flags"] = emptyRecord();
  for (const [key, entry] of Object.entries(manifest.flags)) {
    const remaining = ownedKeys(key, entry).filter((k) => !deleted.has(k));
    if (remaining.length === 0) continue;
    const {
      destKey: _d,
      extraDestKeys: _e,
      dest,
      targetOwned,
      awaitingApproval,
      ...rest
    } = entry;
    // A promoted extra copy was never synchronized by reruns (only the primary is updated), so its
    // cached source versions are dropped and the next --incremental run re-syncs it in full; the
    // recorded destination state described the deleted primary copy and goes too
    const promoted = remaining[0] !== (entry.destKey ?? key);
    flags[key] = {
      ...rest,
      ...(promoted
        ? {
          version: 0,
          lastModified: undefined,
          environments: {},
          ...promotedOwnership(targetOwned, remaining),
        }
        : {
          ...(dest ? { dest } : {}),
          ...(targetOwned ? { targetOwned } : {}),
          ...(awaitingApproval ? { awaitingApproval } : {}),
        }),
      ...(remaining[0] !== key ? { destKey: remaining[0] } : {}),
      ...(remaining.length > 1 ? { extraDestKeys: remaining.slice(1) } : {}),
    };
  }
  // lastSyncTimestamp stays the last migration's end: it is the cutoff for detecting destination edits
  // on copies without a recorded state, and a revert is not a sync
  return { ...manifest, flags };
}

/**
 * Recorded segment copies whose destination environment differs from where the current mapping sends
 * their source environment (`destEnvOf` returns undefined for a source environment not migrated this
 * run). Treating such an entry as an owned copy would overwrite an unrelated segment in the new
 * environment, so a run with a changed mapping must stop before writing. Entries from older versions
 * without a recorded destination environment cannot be checked offline; see legacySegmentEntries.
 */
export function segmentEnvironmentMismatches(
  previous: SyncManifest | null,
  destEnvOf: (sourceEnv: string) => string | undefined,
): string[] {
  const mismatches: string[] = [];
  for (
    const [sourceEnv, segments] of Object.entries(previous?.segments ?? {})
  ) {
    const current = destEnvOf(sourceEnv);
    if (current === undefined) continue;
    for (const [key, entry] of Object.entries(segments)) {
      if (!entry.destEnv) continue;
      const recorded = entry.destEnv;
      if (recorded !== current) {
        mismatches.push(
          `${sourceEnv}/${key}: recorded in destination environment "${recorded}", mapping now targets "${current}"`,
        );
      }
    }
  }
  return mismatches;
}

/**
 * Segment entries from older versions (no recorded destination environment) in source environments
 * migrated this run, with the destination environment the current mapping targets. Their ownership
 * can only be reused after the copy is found there: the caller probes the destination, stamps the
 * entry when found and drops it when not.
 */
export function legacySegmentEntries(
  previous: SyncManifest | null,
  destEnvOf: (sourceEnv: string) => string | undefined,
): Array<{ sourceEnv: string; key: string; destKey: string; destEnv: string }> {
  const legacy: Array<
    { sourceEnv: string; key: string; destKey: string; destEnv: string }
  > = [];
  for (
    const [sourceEnv, segments] of Object.entries(previous?.segments ?? {})
  ) {
    const destEnv = destEnvOf(sourceEnv);
    if (destEnv === undefined) continue;
    for (const [key, entry] of Object.entries(segments)) {
      if (!entry.destEnv) {
        legacy.push({
          sourceEnv,
          key,
          destKey: entry.destKey ?? key,
          destEnv,
        });
      }
    }
  }
  return legacy;
}

/** Destination keys of the flags a manifest records: the destKey when the flag was renamed, else the source key, plus adopted extra copies. */
export function manifestDestinationFlagKeys(manifest: SyncManifest): string[] {
  return [
    ...new Set(
      Object.entries(manifest.flags).flatMap(([key, entry]) =>
        ownedKeys(key, entry)
      ),
    ),
  ];
}
